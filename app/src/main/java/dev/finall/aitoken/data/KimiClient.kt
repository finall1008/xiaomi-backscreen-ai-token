package dev.finall.aitoken.data

import dev.finall.aitoken.model.ProviderAuthException
import dev.finall.aitoken.model.ProviderBooster
import dev.finall.aitoken.model.ProviderId
import dev.finall.aitoken.model.ProviderSnapshot
import dev.finall.aitoken.model.ProviderWindow
import org.json.JSONObject
import java.time.OffsetDateTime

internal class KimiClient(
    private val transport: CodexTransport,
    private val inspectShape: (String, String) -> Unit = { _, _ -> },
) {
    fun fetch(secret: String, nowSeconds: Long = System.currentTimeMillis() / 1000L): ProviderSnapshot {
        val response = transport.execute(
            HttpRequest(
                url = USAGES_URL,
                method = "GET",
                headers = mapOf(
                    "Authorization" to "Bearer $secret",
                    "Accept" to "application/json",
                ),
            ),
        )
        if (response.status == 401) throw ProviderAuthException("Kimi Code API Key 无效或已过期")
        if (response.status !in 200..299) throw Exception("Kimi Code 读取失败（${response.status}）")
        runCatching { inspectShape("usages", jsonShape(response.body)) }
        runCatching { inspectShape("quota", kimiQuotaSummary(response.body)) }
        val parsed = parseKimiUsages(response.body, plan = null, updatedAt = nowSeconds)
        val plan = try {
            readPlan(secret)
        } catch (_: Exception) {
            null
        }
        return parsed.copy(plan = plan)
    }

    private fun readPlan(secret: String): String? {
        val response = transport.execute(
            HttpRequest(
                url = ME_URL,
                method = "GET",
                headers = mapOf(
                    "Authorization" to "Bearer $secret",
                    "Accept" to "application/json",
                ),
            ),
        )
        if (response.status !in 200..299) return null
        runCatching { inspectShape("me", jsonShape(response.body)) }
        return parseKimiPlan(response.body)
    }

    private companion object {
        const val USAGES_URL = "https://api.kimi.com/coding/v1/usages"
        const val ME_URL = "https://api.kimi.com/coding/v1/me"
    }
}

internal fun parseKimiUsages(body: String, plan: String?, updatedAt: Long): ProviderSnapshot {
    val json = try {
        JSONObject(body)
    } catch (_: Exception) {
        throw Exception("Kimi Code 用量数据无法解析")
    }
    val usages = json.optJSONObject("usages")
    val windows = listOfNotNull(
        usages?.kimiWindow("limit5h", "5 小时窗口", FIVE_HOUR_SECONDS),
        usages?.kimiWindow("limit7d", "本周额度", WEEK_SECONDS),
        usages?.kimiWindow("monthCode", "本月额度", MONTH_SECONDS)
            ?: usages?.kimiWindow("monthTotal", "本月额度", MONTH_SECONDS),
    )
    return ProviderSnapshot(
        id = ProviderId.KIMI,
        plan = plan,
        updatedAt = updatedAt,
        windows = windows,
        balance = null,
        credits = null,
        booster = json.kimiBooster(),
        hint = null,
    )
}

internal fun parseKimiPlan(body: String): String? {
    val json = try {
        JSONObject(body)
    } catch (_: Exception) {
        return null
    }
    return json.membershipText() ?: json.nestedMembershipText()
}

internal fun parseIso8601EpochSeconds(raw: String): Long? {
    val trimmed = raw.trim().let { if (it.endsWith("z")) it.dropLast(1) + "Z" else it }
    if (trimmed.isEmpty()) return null
    val zoned = if (hasZone(trimmed)) trimmed else trimmed + "Z"
    val colonOffset = zoned.replace(OFFSET_WITHOUT_COLON, "$1:$2")
    val normalized = colonOffset.replace(TIME_WITHOUT_SECONDS, "T$1:00$2")
    return try {
        OffsetDateTime.parse(normalized).toEpochSecond()
    } catch (_: Exception) {
        null
    }
}

private fun JSONObject.kimiWindow(key: String, title: String, windowSeconds: Long): ProviderWindow? {
    val wireKey = when (key) {
        "limit5h" -> "limit_5h"
        "limit7d" -> "limit_7d"
        "monthCode" -> "limit_month_code"
        "monthTotal" -> "limit_month_total"
        else -> key
    }
    val obj = optJSONObject(wireKey) ?: optJSONObject(key) ?: return null
    val ratio = obj.finiteDouble("used_ratio") ?: obj.finiteDouble("usedRatio") ?: return null
    return ProviderWindow(
        title = title,
        usedPercent = ratio * 100.0,
        windowSeconds = windowSeconds,
        resetAt = obj.isoReset("reset_time") ?: obj.isoReset("resetAt"),
    )
}

private fun JSONObject.kimiBooster(): ProviderBooster? {
    val wallet = when {
        has("boosterWallet") -> {
            if (isNull("boosterWallet")) null else optJSONObject("boosterWallet")
        }
        else -> optJSONObject("usages")?.optJSONObject("boosterWallet")
    } ?: return null
    val balance = wallet.optJSONObject("balance")
    if (balance != null && balance.optString("type") == "BOOSTER") {
        // Official API: millionths of a cent, not the CLI's normalized balanceCents.
        val left = balance.finiteDouble("amountLeft") ?: return null
        val used = wallet.optJSONObject("monthlyUsed")
        val limit = wallet.optJSONObject("monthlyChargeLimit")
        val currency = limit?.optString("currency")?.takeIf { it.isNotBlank() }
            ?: used?.optString("currency")?.takeIf { it.isNotBlank() } ?: "USD"
        return ProviderBooster(left / 100_000_000.0, currency, used?.finiteDouble("priceInCents")?.div(100.0))
    }
    val cents = wallet.finiteDouble("balanceCents") ?: return null
    return ProviderBooster(cents / 100.0, wallet.optString("currency"), wallet.finiteDouble("monthlyUsedCents")?.div(100.0))
}

private fun JSONObject.isoReset(name: String): Long? {
    if (!has(name) || isNull(name)) return null
    val raw = opt(name)
    return if (raw is String) parseIso8601EpochSeconds(raw) else null
}

private fun JSONObject.membershipText(): String? {
    for (key in MEMBERSHIP_KEYS) {
        if (!has(key) || isNull(key)) continue
        val raw = opt(key)
        if (raw is String && raw.isNotBlank()) return raw.trim()
    }
    return null
}

private fun JSONObject.nestedMembershipText(): String? {
    val names = keys()
    while (names.hasNext()) {
        val nested = optJSONObject(names.next()) ?: continue
        nested.membershipText()?.let { return it }
    }
    return null
}

private fun JSONObject.finiteDouble(name: String): Double? {
    if (!has(name) || isNull(name)) return null
    val value = when (val raw = opt(name)) {
        null -> null
        is Number -> raw.toDouble()
        is String -> raw.trim().toDoubleOrNull()
        else -> null
    } ?: return null
    return value.takeIf { it.isFinite() }
}

private fun hasZone(text: String): Boolean {
    if (text.endsWith("Z")) return true
    return ZONE_SUFFIX.containsMatchIn(text)
}

private val MEMBERSHIP_KEYS = listOf("user_level_name", "membership", "tier", "plan", "level")
private val ZONE_SUFFIX = Regex("""[+-]\d{2}:?\d{2}$""")
private val OFFSET_WITHOUT_COLON = Regex("""([+-]\d{2})(\d{2})$""")
private val TIME_WITHOUT_SECONDS = Regex("""T(\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$""")

private const val FIVE_HOUR_SECONDS = 5L * 3600L
private const val WEEK_SECONDS = 7L * 24L * 3600L
private const val MONTH_SECONDS = 30L * 24L * 3600L
