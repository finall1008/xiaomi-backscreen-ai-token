package dev.finall.aitoken.data

import dev.finall.aitoken.model.DeviceLogin
import dev.finall.aitoken.model.UsageSnapshot
import dev.finall.aitoken.model.UsageWindow
import org.json.JSONObject
import java.net.URLEncoder
import java.util.Base64

/** Values taken from openai/codex login (client id, device auth, and oauth token). */
internal const val CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
internal const val AUTH_ISSUER = "https://auth.openai.com"
internal const val DEVICE_CODE_URL = "$AUTH_ISSUER/api/accounts/deviceauth/usercode"
internal const val DEVICE_TOKEN_URL = "$AUTH_ISSUER/api/accounts/deviceauth/token"
internal const val VERIFICATION_URL = "$AUTH_ISSUER/codex/device"
internal const val OAUTH_TOKEN_URL = "$AUTH_ISSUER/oauth/token"
internal const val DEVICE_REDIRECT_URI = "$AUTH_ISSUER/deviceauth/callback"
internal const val USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
internal const val DEVICE_LOGIN_TIMEOUT_MS = 15L * 60L * 1000L
internal const val LONG_WINDOW_SECONDS = 24L * 60L * 60L

internal fun deviceCodeRequestBody(): String =
    JSONObject().put("client_id", CODEX_CLIENT_ID).toString()

internal fun devicePollRequestBody(deviceAuthId: String, userCode: String): String =
    JSONObject()
        .put("device_auth_id", deviceAuthId)
        .put("user_code", userCode)
        .toString()

internal fun authorizationCodeForm(code: String, codeVerifier: String): String = form(
    "grant_type" to "authorization_code",
    "client_id" to CODEX_CLIENT_ID,
    "code" to code,
    "redirect_uri" to DEVICE_REDIRECT_URI,
    "code_verifier" to codeVerifier,
)

internal fun refreshTokenBody(refreshToken: String): String =
    JSONObject()
        .put("client_id", CODEX_CLIENT_ID)
        .put("grant_type", "refresh_token")
        .put("refresh_token", refreshToken)
        .toString()

internal fun parseDeviceLogin(body: String, nowMillis: Long): DeviceLogin {
    val json = readJson(body, "设备码响应无法解析")
    val deviceAuthId = json.stringOrNull("device_auth_id") ?: error("设备码响应缺少登录标识")
    val userCode = json.stringOrNull("user_code") ?: json.stringOrNull("usercode") ?: error("设备码响应缺少验证码")
    val interval = json.longOrNull("interval")?.takeIf { it > 0L } ?: error("设备码响应缺少轮询间隔")
    return DeviceLogin(
        verificationUrl = VERIFICATION_URL,
        userCode = userCode,
        deviceAuthId = deviceAuthId,
        interval = interval,
        start = nowMillis,
    )
}

internal data class DeviceAuthorization(val authorizationCode: String, val codeVerifier: String)

internal fun parseDeviceAuthorization(body: String): DeviceAuthorization {
    val json = readJson(body, "设备码确认响应无法解析")
    val code = json.stringOrNull("authorization_code") ?: error("设备码确认响应不完整")
    val verifier = json.stringOrNull("code_verifier") ?: error("设备码确认响应不完整")
    return DeviceAuthorization(code, verifier)
}

internal data class ExchangedTokens(val idToken: String, val accessToken: String, val refreshToken: String)

internal fun parseExchangedTokens(body: String): ExchangedTokens {
    val json = readJson(body, "令牌交换响应无法解析")
    return ExchangedTokens(
        idToken = json.stringOrNull("id_token") ?: error("令牌交换响应不完整"),
        accessToken = json.stringOrNull("access_token") ?: error("令牌交换响应不完整"),
        refreshToken = json.stringOrNull("refresh_token") ?: error("令牌交换响应不完整"),
    )
}

/** Applies a refresh response. A rotated refresh token is kept even when the access token is omitted. */
internal fun applyRefreshResponse(current: StoredCredentials, body: String): StoredCredentials {
    val json = readJson(body, "登录续期响应无法解析")
    val access = json.stringOrNull("access_token") ?: current.accessToken
    val refresh = json.stringOrNull("refresh_token") ?: current.refreshToken
    val idToken = json.stringOrNull("id_token") ?: current.idToken
    if (!json.has("access_token") && !json.has("refresh_token") && !json.has("id_token")) {
        error("登录续期响应不完整")
    }
    return StoredCredentials(access, refresh, idToken, current.accountId).withAccountId()
}

internal fun oauthFailureMessage(status: Int, body: String): String {
    val code = readJsonOrNull(body)?.optString("error")?.takeIf { it.matches(SAFE_ERROR_CODE) }
    return when (code) {
        "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated", "invalid_grant" ->
            "登录已失效，请重新登录"
        else -> if (status == 401) "登录已失效，请重新登录" else "登录续期失败（$status）"
    }
}

/**
 * Parses chatgpt.com wham usage.
 * A missing or non-numeric used_percent does not become 0.
 * Windows are classified by duration: under 24 hours is the short slot, 24 hours or longer is weekly.
 * A plan that omits the short window stays without one; a returned short window is kept.
 */
internal fun parseUsagePayload(body: String, updatedAt: Long): UsageSnapshot {
    val json = readJson(body, "用量数据无法解析")
    val rate = json.optJSONObject("rate_limit")
    val plan = json.stringOrNull("plan_type") ?: rate?.stringOrNull("plan_type") ?: ""
    val windows = listOfNotNull(
        rate?.let { parseApiWindow(it, "primary_window", updatedAt) },
        rate?.let { parseApiWindow(it, "secondary_window", updatedAt) },
    )
    val (primary, secondary) = classifyWindows(windows)
    return UsageSnapshot(planType = plan, updatedAt = updatedAt, primary = primary, secondary = secondary)
}

internal fun classifyWindows(windows: List<UsageWindow>): Pair<UsageWindow?, UsageWindow?> {
    var primary: UsageWindow? = null
    var secondary: UsageWindow? = null
    for (window in windows) {
        if (window.windowSeconds <= 0L) continue
        if (window.windowSeconds < LONG_WINDOW_SECONDS) {
            if (primary == null) primary = window
        } else if (secondary == null) {
            secondary = window
        }
    }
    return primary to secondary
}

internal fun UsageSnapshot.toCacheJson(): String =
    JSONObject()
        .put("planType", planType)
        .put("updatedAt", updatedAt)
        .put("primary", primary?.toCacheObject() ?: JSONObject.NULL)
        .put("secondary", secondary?.toCacheObject() ?: JSONObject.NULL)
        .toString()

internal fun parseCachedUsage(text: String): UsageSnapshot? {
    val json = readJsonOrNull(text) ?: return null
    if (!json.has("updatedAt") || json.isNull("updatedAt")) return null
    val updatedAt = json.longOrNull("updatedAt") ?: return null
    if (updatedAt < 0L) return null
    return UsageSnapshot(
        planType = json.stringOrNull("planType") ?: "",
        updatedAt = updatedAt,
        primary = json.cachedWindow("primary"),
        secondary = json.cachedWindow("secondary"),
    )
}

internal fun chatgptAccountId(jwt: String): String? {
    val auth = decodeJwtPayload(jwt)?.optJSONObject("https://api.openai.com/auth") ?: return null
    return auth.stringOrNull("chatgpt_account_id")
}

internal fun StoredCredentials.withAccountId(): StoredCredentials {
    if (accountId.isNotBlank()) return this
    val resolved = chatgptAccountId(idToken) ?: chatgptAccountId(accessToken) ?: return this
    return copy(accountId = resolved)
}

private fun parseApiWindow(rate: JSONObject, key: String, nowSeconds: Long): UsageWindow? {
    if (!rate.has(key) || rate.isNull(key)) return null
    val obj = rate.optJSONObject(key) ?: return null
    val used = obj.finiteDouble("used_percent") ?: return null
    val seconds = windowSeconds(obj) ?: return null
    if (seconds <= 0L) return null
    return UsageWindow(usedPercent = used, windowSeconds = seconds, resetAt = resetAt(obj, nowSeconds))
}

private fun windowSeconds(obj: JSONObject): Long? {
    obj.longOrNull("limit_window_seconds")?.let { return it }
    obj.longOrNull("window_seconds")?.let { return it }
    obj.longOrNull("window_minutes")?.let { return it * 60L }
    return null
}

private fun resetAt(obj: JSONObject, nowSeconds: Long): Long? {
    obj.longOrNull("reset_at")?.takeIf { it > 0L }?.let { return it }
    obj.longOrNull("resets_at")?.takeIf { it > 0L }?.let { return it }
    val after = obj.longOrNull("reset_after_seconds") ?: return null
    if (after < 0L) return null
    return nowSeconds + after
}

private fun UsageWindow.toCacheObject(): JSONObject =
    JSONObject()
        .put("usedPercent", usedPercent)
        .put("windowSeconds", windowSeconds)
        .put("resetAt", resetAt ?: JSONObject.NULL)

private fun JSONObject.cachedWindow(key: String): UsageWindow? {
    if (!has(key) || isNull(key)) return null
    val obj = optJSONObject(key) ?: return null
    val used = obj.finiteDouble("usedPercent") ?: return null
    val seconds = obj.longOrNull("windowSeconds") ?: return null
    if (seconds <= 0L) return null
    return UsageWindow(used, seconds, obj.longOrNull("resetAt")?.takeIf { it > 0L })
}

private fun readJson(body: String, failure: String): JSONObject =
    readJsonOrNull(body) ?: error(failure)

private fun readJsonOrNull(body: String): JSONObject? = try {
    JSONObject(body)
} catch (_: Exception) {
    null
}

private fun decodeJwtPayload(jwt: String): JSONObject? {
    val payload = jwt.split('.').getOrNull(1)?.takeIf { it.isNotBlank() } ?: return null
    val padded = payload + "=".repeat((4 - payload.length % 4) % 4)
    return try {
        val bytes = Base64.getUrlDecoder().decode(padded)
        JSONObject(String(bytes, Charsets.UTF_8))
    } catch (_: Exception) {
        null
    }
}

private fun form(vararg pairs: Pair<String, String>): String =
    pairs.joinToString("&") { (key, value) ->
        URLEncoder.encode(key, Charsets.UTF_8) + "=" + URLEncoder.encode(value, Charsets.UTF_8)
    }

private fun JSONObject.stringOrNull(name: String): String? {
    if (!has(name) || isNull(name)) return null
    return optString(name).trim().takeIf { it.isNotEmpty() }
}

private fun JSONObject.longOrNull(name: String): Long? {
    if (!has(name) || isNull(name)) return null
    return when (val raw = opt(name)) {
        is Number -> raw.toLong()
        is String -> raw.trim().toLongOrNull() ?: raw.trim().toDoubleOrNull()?.toLong()
        else -> null
    }
}

private fun JSONObject.finiteDouble(name: String): Double? {
    if (!has(name) || isNull(name)) return null
    val value = when (val raw = opt(name)) {
        is Number -> raw.toDouble()
        is String -> raw.trim().toDoubleOrNull()
        else -> null
    } ?: return null
    return value.takeIf { it.isFinite() }
}

private val SAFE_ERROR_CODE = Regex("[A-Za-z0-9_]+")
