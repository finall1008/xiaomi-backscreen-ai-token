package dev.finall.aitoken.data

import dev.finall.aitoken.model.ProviderAuthException
import dev.finall.aitoken.model.ProviderBalance
import dev.finall.aitoken.model.ProviderId
import dev.finall.aitoken.model.ProviderSnapshot
import org.json.JSONArray
import org.json.JSONObject

internal class DeepSeekClient(
    private val transport: CodexTransport,
) {
    fun fetch(secret: String, nowSeconds: Long = System.currentTimeMillis() / 1000L): ProviderSnapshot {
        val response = transport.execute(
            HttpRequest(
                url = BALANCE_URL,
                method = "GET",
                headers = mapOf(
                    "Authorization" to "Bearer $secret",
                    "Accept" to "application/json",
                ),
            ),
        )
        if (response.status == 401) throw ProviderAuthException("DeepSeek API Key 无效或已过期")
        if (response.status !in 200..299) throw Exception("DeepSeek 读取失败（${response.status}）")
        return parseDeepSeekBalance(response.body, nowSeconds)
    }

    private companion object {
        const val BALANCE_URL = "https://api.deepseek.com/user/balance"
    }
}

internal fun parseDeepSeekBalance(body: String, updatedAt: Long): ProviderSnapshot {
    val json = try {
        JSONObject(body)
    } catch (_: Exception) {
        throw Exception("DeepSeek 余额数据无法解析")
    }
    val infos = json.optJSONArray("balance_infos") ?: throw Exception("DeepSeek 余额数据无法解析")
    val selected = selectBalance(infos) ?: throw Exception("DeepSeek 余额数据无法解析")
    val total = selected.firstFinite("total_balance", "totalBalance", "total")
        ?: throw Exception("DeepSeek 余额数据无法解析")
    val currency = selected.optString("currency").trim()
    val granted = selected.firstFinite("granted_balance", "grantedBalance", "granted")
    val toppedUp = selected.firstFinite("topped_up_balance", "toppedUpBalance", "topped_up", "toppedUp")
    val available = selected.flexibleBoolean("is_available", "isAvailable")
        ?: json.flexibleBoolean("is_available", "isAvailable")
        ?: false
    return ProviderSnapshot(
        id = ProviderId.DEEPSEEK,
        plan = "api",
        updatedAt = updatedAt,
        windows = emptyList(),
        balance = ProviderBalance(
            amount = total,
            currency = currency,
            granted = granted,
            toppedUp = toppedUp,
            isAvailable = available,
        ),
        credits = null,
        booster = null,
        hint = null,
    )
}

private fun selectBalance(infos: JSONArray): JSONObject? {
    var first: JSONObject? = null
    for (index in 0 until infos.length()) {
        val item = infos.optJSONObject(index) ?: continue
        if (first == null) first = item
        if (item.optString("currency").trim() == "CNY") return item
    }
    return first
}

private fun JSONObject.firstFinite(vararg names: String): Double? {
    for (name in names) {
        finiteDouble(name)?.let { return it }
    }
    return null
}

private fun JSONObject.flexibleBoolean(vararg names: String): Boolean? {
    for (name in names) {
        if (!has(name) || isNull(name)) continue
        return when (val raw = opt(name)) {
            null -> null
            is Boolean -> raw
            is Number -> raw.toInt() != 0
            is String -> when (raw.trim().lowercase()) {
                "true", "1" -> true
                "false", "0" -> false
                else -> null
            }
            else -> null
        }
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
