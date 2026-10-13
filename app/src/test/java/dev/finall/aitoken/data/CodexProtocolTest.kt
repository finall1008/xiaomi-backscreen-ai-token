package dev.finall.aitoken.data

import dev.finall.aitoken.model.DeviceLogin
import dev.finall.aitoken.model.UsageWindow
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.URLDecoder
import java.util.Base64
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger

class CodexProtocolTest {
    @Test fun deviceLoginPollsThenExchangesAtOfficialEndpoints() = runBlocking {
        val transport = RecordingTransport { request ->
            when (request.url) {
                DEVICE_CODE_URL -> {
                    assertEquals("POST", request.method)
                    assertEquals(CODEX_CLIENT_ID, JSONObject(request.body!!).getString("client_id"))
                    HttpResponse(200, """{"device_auth_id":"dev-1","user_code":"ABCD-EFGH","interval":"5"}""")
                }
                DEVICE_TOKEN_URL -> {
                    val body = JSONObject(request.body!!)
                    assertEquals("dev-1", body.getString("device_auth_id"))
                    assertEquals("ABCD-EFGH", body.getString("user_code"))
                    if (requestCount(request.url) == 1) HttpResponse(403, "pending-secret")
                    else HttpResponse(200, """{"authorization_code":"auth-code","code_verifier":"verifier-1","code_challenge":"ignored"}""")
                }
                OAUTH_TOKEN_URL -> {
                    assertEquals("application/x-www-form-urlencoded", request.headers["Content-Type"])
                    val form = formFields(request.body!!)
                    assertEquals("authorization_code", form["grant_type"])
                    assertEquals(CODEX_CLIENT_ID, form["client_id"])
                    assertEquals("auth-code", form["code"])
                    assertEquals(DEVICE_REDIRECT_URI, form["redirect_uri"])
                    assertEquals("verifier-1", form["code_verifier"])
                    HttpResponse(200, """{"id_token":"${jwt("acc-9")}","access_token":"access-1","refresh_token":"refresh-1"}""")
                }
                USAGE_URL -> {
                    assertEquals("Bearer access-1", request.headers["Authorization"])
                    assertEquals("acc-9", request.headers["ChatGPT-Account-Id"])
                    HttpResponse(200, PLUS_USAGE)
                }
                else -> error("unexpected ${request.url}")
            }
        }
        val sleeps = mutableListOf<Long>()
        val store = MemoryCredentialStore()
        val cache = MemoryUsageCache()
        val repo = CodexRepository(store, cache, transport, nowMillis = { 1_000L }, sleepMillis = { sleeps += it })
        val login = repo.requestDeviceCode()
        assertEquals(VERIFICATION_URL, login.verificationUrl)
        assertEquals("ABCD-EFGH", login.userCode)
        assertFalse(login.toString().contains("ABCD-EFGH"))
        val snapshot = repo.completeDeviceLogin(login)
        assertEquals(listOf(5_000L), sleeps)
        assertEquals("plus", snapshot.planType)
        assertEquals(UsageWindow(23.5, 18_000, 1_800_000_100), snapshot.primary)
        assertEquals("refresh-1", store.current?.refreshToken)
        assertEquals(snapshot, cache.current)
        assertTrue(repo.isSignedIn())
    }

    @Test fun deviceLoginStopsAtFifteenMinutes() = runBlocking {
        var calls = 0
        val repo = CodexRepository(
            MemoryCredentialStore(),
            MemoryUsageCache(),
            CodexTransport { calls++; HttpResponse(403, "") },
            nowMillis = { DEVICE_LOGIN_TIMEOUT_MS },
        )
        val login = DeviceLogin(VERIFICATION_URL, "CODE", "dev", 5, start = 0)
        try {
            repo.completeDeviceLogin(login)
            fail("expected timeout")
        } catch (error: IllegalStateException) {
            assertTrue(error.message!!.contains("15"))
            assertFalse(error.message!!.contains("CODE"))
        }
        assertEquals(0, calls)
    }

    @Test fun cancelStopsPollingWithoutSavingCredentials() = runBlocking {
        var calls = 0
        val store = MemoryCredentialStore()
        val repo = CodexRepository(
            store,
            MemoryUsageCache(),
            CodexTransport { calls++; HttpResponse(403, "secret-body") },
            nowMillis = { 0L },
            sleepMillis = { delay(60_000) },
        )
        val job = launch {
            repo.completeDeviceLogin(DeviceLogin(VERIFICATION_URL, "CODE", "dev", 5, start = 0))
        }
        while (calls == 0) yield()
        job.cancel()
        job.join()
        assertNull(store.current)
        assertTrue(calls < 3)
    }

    @Test fun unauthorizedUsageRefreshesOnceThenRetries() = runBlocking {
        val store = MemoryCredentialStore()
        store.save(StoredCredentials("old-access", "old-refresh", jwt("acc-1"), "acc-1"))
        val cache = MemoryUsageCache()
        var refreshes = 0
        val transport = RecordingTransport { request ->
            when (request.url) {
                USAGE_URL -> if (request.headers["Authorization"] == "Bearer old-access") {
                    HttpResponse(401, """{\"access_token\":\"should-not-surface\"}""")
                } else {
                    assertEquals("Bearer new-access", request.headers["Authorization"])
                    assertEquals("acc-1", request.headers["ChatGPT-Account-Id"])
                    HttpResponse(200, PLUS_USAGE)
                }
                OAUTH_TOKEN_URL -> {
                    refreshes += 1
                    assertEquals("application/json", request.headers["Content-Type"])
                    val body = JSONObject(request.body!!)
                    assertEquals(CODEX_CLIENT_ID, body.getString("client_id"))
                    assertEquals("refresh_token", body.getString("grant_type"))
                    assertEquals("old-refresh", body.getString("refresh_token"))
                    assertEquals(OAUTH_TOKEN_URL, request.url)
                    HttpResponse(200, """{"access_token":"new-access","refresh_token":"new-refresh","id_token":"${jwt("acc-1")}"}""")
                }
                else -> error("unexpected ${request.url}")
            }
        }
        val repo = CodexRepository(store, cache, transport, nowMillis = { 2_000L })
        val snapshot = repo.refreshUsage()
        assertEquals(1, refreshes)
        assertEquals(2, transport.requests.count { it.url == USAGE_URL })
        assertEquals("new-refresh", store.current?.refreshToken)
        assertEquals("plus", snapshot.planType)
        assertEquals(2L, cache.current?.updatedAt)
        repo.signOut()
        assertFalse(repo.isSignedIn())
        assertNull(repo.cachedUsage())
        assertNull(store.current)
    }

    @Test fun secondUnauthorizedDoesNotRefreshAgain() = runBlocking {
        val store = MemoryCredentialStore()
        store.save(StoredCredentials("old-access", "old-refresh", jwt("acc-1"), "acc-1"))
        var refreshes = 0
        val transport = RecordingTransport { request ->
            when (request.url) {
                USAGE_URL -> HttpResponse(401, "token-body-secret")
                OAUTH_TOKEN_URL -> {
                    refreshes += 1
                    HttpResponse(401, """{"error":"refresh_token_expired","error_description":"secret-refresh"}""")
                }
                else -> error("unexpected")
            }
        }
        val repo = CodexRepository(store, MemoryUsageCache(), transport)
        try {
            repo.refreshUsage()
            fail("expected auth failure")
        } catch (error: IllegalStateException) {
            assertEquals("登录已失效，请重新登录", error.message)
            assertFalse(error.message!!.contains("secret"))
            assertFalse(error.message!!.contains("old-refresh"))
        }
        assertEquals(1, refreshes)
        assertEquals(1, transport.requests.count { it.url == USAGE_URL })
        assertEquals("old-refresh", store.current?.refreshToken)
    }

    @Test fun rotatedRefreshIsKeptWhenRetryIsStillUnauthorized() = runBlocking {
        val store = MemoryCredentialStore()
        store.save(StoredCredentials("old-access", "old-refresh", jwt("acc-1"), "acc-1"))
        var refreshes = 0
        val transport = CodexTransport { request ->
            when (request.url) {
                USAGE_URL -> HttpResponse(401, "")
                OAUTH_TOKEN_URL -> {
                    refreshes += 1
                    HttpResponse(200, """{"access_token":"new-access","refresh_token":"rotated"}""")
                }
                else -> error("unexpected")
            }
        }
        val repo = CodexRepository(store, MemoryUsageCache(), transport)
        try {
            repo.refreshUsage()
            fail("expected auth failure")
        } catch (error: IllegalStateException) {
            assertEquals("登录已失效，请重新登录", error.message)
        }
        assertEquals(1, refreshes)
        assertEquals("rotated", store.current?.refreshToken)
        assertEquals("new-access", store.current?.accessToken)
    }

    @Test fun concurrentRefreshRotatesOnce() = runBlocking {
        val store = MemoryCredentialStore()
        store.save(StoredCredentials("old-access", "old-refresh", jwt("acc-1"), "acc-1"))
        val refreshes = AtomicInteger()
        val transport = CodexTransport { request ->
            when {
                request.url == USAGE_URL && request.headers["Authorization"] == "Bearer old-access" ->
                    HttpResponse(401, "")
                request.url == USAGE_URL -> HttpResponse(200, PLUS_USAGE)
                request.url == OAUTH_TOKEN_URL -> {
                    refreshes.incrementAndGet()
                    Thread.sleep(150)
                    HttpResponse(200, """{"access_token":"new-access","refresh_token":"rotated"}""")
                }
                else -> error("unexpected")
            }
        }
        val repo = CodexRepository(store, MemoryUsageCache(), transport, nowMillis = { 5_000L })
        coroutineScope {
            List(2) { async(Dispatchers.IO) { repo.refreshUsage() } }.awaitAll()
        }
        assertEquals(1, refreshes.get())
        assertEquals("rotated", store.current?.refreshToken)
    }

    @Test fun signOutDuringRefreshDoesNotWriteUsageBack() = runBlocking {
        withTimeout(5_000) {
            val store = MemoryCredentialStore()
            store.save(StoredCredentials("access-1", "refresh-1", jwt("acc-1"), "acc-1"))
            val cache = MemoryUsageCache()
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val transport = CodexTransport { request ->
                if (request.url != USAGE_URL) error("unexpected ${request.url}")
                if (!entered.isCompleted) entered.complete(Unit)
                while (!release.isCompleted) Thread.sleep(5)
                HttpResponse(200, PLUS_USAGE)
            }
            val repo = CodexRepository(store, cache, transport, nowMillis = { 9_000L })
            val refreshJob = async(Dispatchers.IO) { runCatching { repo.refreshUsage() } }
            entered.await()
            val signOutJob = async(Dispatchers.IO) { repo.signOut() }
            delay(50)
            release.complete(Unit)
            refreshJob.await()
            signOutJob.await()
            assertNull(cache.current)
            assertFalse(repo.isSignedIn())
        }
    }

    @Test fun cancelledRefreshDoesNotSaveUsage() = runBlocking {
        withTimeout(5_000) {
            val store = MemoryCredentialStore()
            store.save(StoredCredentials("access-1", "refresh-1", jwt("acc-1"), "acc-1"))
            val cache = MemoryUsageCache()
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val transport = CodexTransport { _ ->
                if (!entered.isCompleted) entered.complete(Unit)
                while (!release.isCompleted) Thread.sleep(5)
                HttpResponse(200, PLUS_USAGE)
            }
            val repo = CodexRepository(store, cache, transport, nowMillis = { 9_000L })
            val job = launch(Dispatchers.IO) { repo.refreshUsage() }
            entered.await()
            job.cancel()
            release.complete(Unit)
            job.join()
            assertNull(cache.current)
            assertTrue(repo.isSignedIn())
        }
    }

    private fun jwt(accountId: String): String {
        val encoder = Base64.getUrlEncoder().withoutPadding()
        val header = encoder.encodeToString("""{"alg":"none"}""".toByteArray())
        val payload = encoder.encodeToString(
            """{"https://api.openai.com/auth":{"chatgpt_account_id":"$accountId"}}""".toByteArray(),
        )
        return "$header.$payload.sig"
    }

    private fun formFields(body: String): Map<String, String> = body.split("&").associate { pair ->
        val parts = pair.split("=", limit = 2)
        URLDecoder.decode(parts[0], Charsets.UTF_8) to URLDecoder.decode(parts[1], Charsets.UTF_8)
    }

    private class MemoryCredentialStore : CredentialStore {
        var current: StoredCredentials? = null
        override fun load(): StoredCredentials? = current
        override fun save(credentials: StoredCredentials) { current = credentials }
        override fun clear() { current = null }
    }

    private class MemoryUsageCache : UsageCache {
        var current: dev.finall.aitoken.model.UsageSnapshot? = null
        override fun load() = current
        override fun save(snapshot: dev.finall.aitoken.model.UsageSnapshot) { current = snapshot }
        override fun clear() { current = null }
    }

    private class RecordingTransport(
        private val handler: RecordingTransport.(HttpRequest) -> HttpResponse,
    ) : CodexTransport {
        val requests = Collections.synchronizedList(mutableListOf<HttpRequest>())
        override fun execute(request: HttpRequest): HttpResponse {
            requests += request
            return handler(request)
        }
        fun requestCount(url: String) = requests.count { it.url == url }
    }

    private companion object {
        const val PLUS_USAGE = """{"plan_type":"plus","rate_limit":{"primary_window":{"used_percent":23.5,"limit_window_seconds":18000,"reset_at":1800000100},"secondary_window":{"used_percent":4,"limit_window_seconds":604800,"reset_at":1800500000}}}"""
    }
}
