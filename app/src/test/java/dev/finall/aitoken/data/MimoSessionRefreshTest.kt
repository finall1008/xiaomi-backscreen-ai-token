package dev.finall.aitoken.data

import dev.finall.aitoken.model.ProviderAuthException
import org.junit.Assert.*
import org.junit.Test

class MimoSessionRefreshTest {
    @Test fun passportSessionRestoresPlatformCookieOverHttps() {
        val requests = mutableListOf<HttpRequest>()
        var platformCookie = "api-platform_serviceToken=expired"
        val transport = CodexTransport { request ->
            requests += request
            when (requests.size) {
                1 -> HttpResponse(401, """{"code":401,"loginUrl":"https://account.xiaomi.com/pass/serviceLogin?sid=api-platform"}""")
                2 -> {
                    assertEquals("passToken=account-session", request.headers["Cookie"])
                    HttpResponse(302, "", mapOf("Location" to listOf("http://platform.xiaomimimo.com/sts")))
                }
                3 -> HttpResponse(302, "", mapOf(
                    "Set-Cookie" to listOf("api-platform_serviceToken=renewed; HttpOnly; Path=/"),
                    "Location" to listOf("/console/plan-manage"),
                ))
                else -> HttpResponse(200, "")
            }
        }
        val renewed = restoreMimoSession(transport,
            getCookie = { if (it.contains("account.xiaomi.com")) "passToken=account-session" else platformCookie },
            setCookie = { _, value -> platformCookie = value.substringBefore(';'); true },
        )
        assertEquals("api-platform_serviceToken=renewed", renewed)
        assertEquals("https://platform.xiaomimimo.com/sts", requests[2].url)
        assertEquals(renewed, requests[3].headers["Cookie"])
    }

    @Test fun interactiveLoginIsReportedAsExpiredInsteadOfReturningOldPlatformCookie() {
        var count = 0
        val transport = CodexTransport {
            if (++count == 1) HttpResponse(401, """{"loginUrl":"https://account.xiaomi.com/pass/serviceLogin"}""")
            else HttpResponse(200, "<html>login required</html>")
        }
        assertThrows(ProviderAuthException::class.java) {
            restoreMimoSession(transport,
                getCookie = { if (it.contains("account.xiaomi.com")) "passToken=expired" else "api-platform_serviceToken=old" },
                setCookie = { _, _ -> true },
            )
        }
        assertEquals(2, count)
    }

    @Test fun serviceFailureDoesNotBecomeAnExpiredAccountNotification() {
        var count = 0
        val transport = CodexTransport {
            if (++count == 1) HttpResponse(401, """{"loginUrl":"https://account.xiaomi.com/pass/serviceLogin"}""")
            else HttpResponse(503, "")
        }
        val error = assertThrows(Exception::class.java) {
            restoreMimoSession(transport, getCookie = { "passToken=session" }, setCookie = { _, _ -> true })
        }
        assertFalse(error is ProviderAuthException)
    }
}
