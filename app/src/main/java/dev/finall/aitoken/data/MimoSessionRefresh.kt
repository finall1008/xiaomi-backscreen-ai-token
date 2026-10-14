package dev.finall.aitoken.data

import android.webkit.CookieManager
import dev.finall.aitoken.model.ProviderAuthException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import java.net.URI
import kotlin.coroutines.resume

/** Reuse Passport's existing session without launching a WebView or a login Activity. */
internal fun restoreMimoSession(transport: CodexTransport): String {
    val cookies = CookieManager.getInstance()
    return restoreMimoSession(
        transport,
        getCookie = { cookies.getCookie(it) },
        setCookie = { url, value ->
            runBlocking(Dispatchers.Main.immediate) {
                suspendCancellableCoroutine { continuation ->
                    cookies.setCookie(url, value) { accepted -> continuation.resume(accepted) }
                }
            }
        },
    ).also { cookies.flush() }
}

internal fun restoreMimoSession(
    transport: CodexTransport,
    getCookie: (String) -> String?,
    setCookie: (String, String) -> Boolean,
): String {
    val authError = { ProviderAuthException("小米账号会话已失效，请重新登录") }
    if (getCookie("https://account.xiaomi.com").orEmpty().split(';')
            .none { it.trim().startsWith("passToken=") }) throw authError()
    var url = requestMimoLoginUrl(transport)
    repeat(8) {
        val uri = URI(url)
        // Passport's followup sometimes uses HTTP; never send credentials over it.
        if (uri.host !in setOf("account.xiaomi.com", "platform.xiaomimimo.com") ||
            uri.scheme !in setOf("http", "https")) {
            throw Exception("小米授权跳转地址异常")
        }
        url = if (uri.scheme == "http") "https" + url.substring(4) else url
        val response = transport.execute(HttpRequest(url, "GET", headers = mapOf(
            "Cookie" to getCookie(url).orEmpty(),
        )))
        if (response.status >= 500) throw Exception("小米授权服务响应异常（${response.status}）")
        response.headers.entries.filter { it.key.equals("Set-Cookie", ignoreCase = true) }
            .flatMap { it.value }.forEach { value ->
                if (!setCookie(url, value)) throw Exception("无法保存小米账号会话")
            }
        if (response.status in listOf(301, 302, 303, 307, 308)) {
            val location = response.headers.entries.firstOrNull { it.key.equals("Location", ignoreCase = true) }
                ?.value?.firstOrNull() ?: throw Exception("小米授权跳转缺少地址")
            url = URI(url).resolve(location).toString()
        } else {
            // A Passport HTML page means interaction is required. Do not open it in the background.
            if (uri.host != "platform.xiaomimimo.com" || response.status == 401) throw authError()
            return getCookie("https://platform.xiaomimimo.com")
                ?.takeIf { cookie -> cookie.split(';').any { it.trim().startsWith("api-platform_serviceToken=") } }
                ?: throw authError()
        }
    }
    throw Exception("小米授权跳转次数过多")
}
