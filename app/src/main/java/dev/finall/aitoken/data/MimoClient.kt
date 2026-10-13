package dev.finall.aitoken.data

import dev.finall.aitoken.model.ProviderAuthException
import dev.finall.aitoken.model.ProviderCredits
import dev.finall.aitoken.model.ProviderId
import dev.finall.aitoken.model.ProviderSnapshot
import dev.finall.aitoken.model.ProviderWindow
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

internal class MimoClient(
    private val transport: CodexTransport,
    private val onDiagnostic: ((String, String) -> Unit)? = null,
) {
    fun fetch(secret: String, nowSeconds: Long = System.currentTimeMillis() / 1000L): ProviderSnapshot {
        val response = transport.execute(mimoRequest(USAGE_URL, secret))
        if (response.status == 401 || jsonCode(response.body) == 401) {
            throw ProviderAuthException("小米账号登录已过期，请重新登录")
        }
        if (response.status !in 200..299) throw Exception("小米 MiMo 读取失败（${response.status}）")
        runCatching { onDiagnostic?.invoke("usage", jsonShape(response.body)) }
        val detail = readDetail(secret)
        return parseMimoUsage(response.body, detail, nowSeconds)
    }

    private fun readDetail(secret: String): MimoPlanDetail? = try {
        val response = transport.execute(mimoRequest(DETAIL_URL, secret))
        runCatching { onDiagnostic?.invoke("detail", jsonShape(response.body)) }
        if (response.status !in 200..299) null else parseMimoDetail(response.body)
    } catch (_: Exception) {
        null
    }

    private fun mimoRequest(url: String, secret: String) = HttpRequest(
        url = url,
        method = "GET",
        headers = mapOf(
            "Cookie" to secret,
            "Accept" to "application/json",
        ),
    )

    private companion object {
        const val USAGE_URL = "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage"
        const val DETAIL_URL = "https://platform.xiaomimimo.com/api/v1/tokenPlan/detail"
    }
}

internal data class MimoPlanDetail(
    val plan: String?,
    val periodEnd: Long?,
    val cycle: String? = null,
)

internal fun parseMimoUsage(body: String, detail: MimoPlanDetail?, updatedAt: Long): ProviderSnapshot {
    val json = try {
        JSONObject(body)
    } catch (_: Exception) {
        throw Exception("小米 MiMo 用量数据无法解析")
    }
    val code = json.flexibleInt("code")
    if (code == 401) throw ProviderAuthException("小米账号登录已过期，请重新登录")
    if (code == null) throw Exception("小米 MiMo 用量数据无法解析")
    if (code != 0) throw Exception("小米 MiMo 读取失败（$code）")
    val usage = json.optJSONObject("data")?.optJSONObject("usage")
    val items = usage?.optJSONArray("items")
    val creditItem = findUsageItem(items, "plan_total_token") ?: findUsageItem(items, "month_total_token")
    val periodEnd = detail?.periodEnd
    val credits = creditItem?.let { item ->
        val used = item.finiteDouble("used")
        val limit = item.finiteDouble("limit")
        if (used == null || limit == null) null else ProviderCredits(used, limit, periodEnd)
    }
    val percent = usage?.finiteDouble("percent")
    val windows = if (percent == null) {
        emptyList()
    } else {
        val title = when (detail?.cycle) {
            "year" -> "年度额度"
            "month" -> "本月额度"
            else -> "套餐额度"
        }
        val seconds = when (detail?.cycle) {
            "year" -> 365L * 24L * 3600L
            "month" -> MONTH_SECONDS
            else -> 0L
        }
        listOf(ProviderWindow(title, percent * 100.0, seconds, periodEnd))
    }
    return ProviderSnapshot(
        id = ProviderId.MIMO,
        plan = detail?.plan,
        updatedAt = updatedAt,
        windows = windows,
        balance = null,
        credits = credits,
        booster = null,
        hint = null,
    )
}

internal fun parseMimoDetail(body: String): MimoPlanDetail? {
    val json = try {
        JSONObject(body)
    } catch (_: Exception) {
        return null
    }
    val code = json.flexibleInt("code")
    if (code != null && code != 0) return null
    val data = json.optJSONObject("data") ?: return null
    val cycle = data.textValue("planCode")?.lowercase(Locale.ROOT)?.substringAfterLast(':')
        ?.takeIf { it == "year" || it == "month" }
    val name = PLAN_KEYS.firstNotNullOfOrNull { key -> data.textValue(key) }
    val plan = when (cycle) {
        "year" -> name?.let { "$it · 年度套餐" }
        "month" -> name?.let { "$it · 月度套餐" }
        else -> name?.lowercase(Locale.ROOT)
    }
    val periodEnd = PERIOD_KEYS.firstNotNullOfOrNull { key ->
        if (!data.has(key) || data.isNull(key)) null else parseFlexibleEpoch(data.opt(key))
    }
    if (plan == null && periodEnd == null) return null
    return MimoPlanDetail(plan, periodEnd, cycle)
}

internal fun parseFlexibleEpoch(raw: Any?): Long? {
    return when (raw) {
        null, JSONObject.NULL -> null
        is Number -> normalizeEpoch(raw.toLong())
        is String -> {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) {
                null
            } else {
                trimmed.toLongOrNull()?.let { return normalizeEpoch(it) }
                trimmed.toDoubleOrNull()?.let { return normalizeEpoch(it.toLong()) }
                parseIso8601EpochSeconds(trimmed) ?: runCatching {
                    // MiMo's actual currentPeriodEnd uses mainland platform local time without an offset.
                    java.time.LocalDateTime.parse(trimmed, java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"))
                        .atZone(java.time.ZoneId.of("Asia/Shanghai")).toEpochSecond()
                }.getOrNull()
            }
        }
        else -> null
    }
}

private fun findUsageItem(items: JSONArray?, name: String): JSONObject? {
    if (items == null) return null
    for (index in 0 until items.length()) {
        val item = items.optJSONObject(index) ?: continue
        if (item.optString("name") == name) return item
    }
    return null
}

private fun jsonCode(body: String): Int? = try {
    JSONObject(body).flexibleInt("code")
} catch (_: Exception) {
    null
}

private fun JSONObject.textValue(name: String): String? {
    if (!has(name) || isNull(name)) return null
    val raw = opt(name)
    return if (raw is String) raw.trim().takeIf { it.isNotEmpty() } else null
}

private fun JSONObject.flexibleInt(name: String): Int? {
    if (!has(name) || isNull(name)) return null
    return when (val raw = opt(name)) {
        null -> null
        is Number -> raw.toInt()
        is String -> raw.trim().toIntOrNull() ?: raw.trim().toDoubleOrNull()?.toInt()
        else -> null
    }
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

private fun normalizeEpoch(value: Long): Long? {
    if (value <= 0L) return null
    return if (value >= 1_000_000_000_000L) value / 1000L else value
}

private val PLAN_KEYS = listOf("planName", "plan_name", "name", "title", "planNameCn")
private val PERIOD_KEYS = listOf("currentPeriodEnd", "periodEnd", "period_end", "endTime", "end_time", "expireTime")
private const val MONTH_SECONDS = 30L * 24L * 3600L
