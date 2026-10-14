package dev.finall.aitoken.data

import org.json.JSONObject
import java.net.URI

/** Obtain the platform's signed Passport callback; never guess or persist this URL. */
internal fun requestMimoLoginUrl(transport: CodexTransport = HttpUrlConnectionTransport()): String {
    val response = transport.execute(
        HttpRequest("https://platform.xiaomimimo.com/api/v1/tokenPlan/usage", "GET"),
    )
    val url = runCatching { JSONObject(response.body).optString("loginUrl") }.getOrNull()
        ?.takeIf { it.isNotBlank() } ?: error("无法获取小米账号登录入口（${response.status}），请重试")
    val uri = URI(url)
    check(uri.scheme == "https" && uri.host == "account.xiaomi.com") { "小米账号登录入口异常" }
    return url
}
