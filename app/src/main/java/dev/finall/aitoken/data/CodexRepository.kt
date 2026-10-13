package dev.finall.aitoken.data

import android.content.Context
import dev.finall.aitoken.model.DeviceLogin
import dev.finall.aitoken.model.UsageSnapshot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlin.coroutines.coroutineContext

class CodexRepository internal constructor(
    private val credentials: CredentialStore,
    private val usageCache: UsageCache,
    private val transport: CodexTransport,
    private val nowMillis: () -> Long = { System.currentTimeMillis() },
    private val sleepMillis: suspend (Long) -> Unit = { delay(it) },
) {
    constructor(context: Context) : this(
        AndroidCredentialStore(context),
        FileUsageCache(context),
        HttpUrlConnectionTransport(),
    )

    fun isSignedIn(): Boolean {
        val stored = credentials.load() ?: return false
        return stored.accessToken.isNotBlank() && stored.refreshToken.isNotBlank()
    }

    fun cachedUsage(): UsageSnapshot? = usageCache.load()

    suspend fun requestDeviceCode(): DeviceLogin = withContext(Dispatchers.IO) {
        val response = transport.execute(
            HttpRequest(
                url = DEVICE_CODE_URL,
                method = "POST",
                headers = mapOf("Content-Type" to "application/json"),
                body = deviceCodeRequestBody(),
            )
        )
        if (response.status == 404) error("当前服务未开启设备码登录")
        if (response.status !in 200..299) error("设备码申请失败（${response.status}）")
        parseDeviceLogin(response.body, nowMillis())
    }

    suspend fun completeDeviceLogin(login: DeviceLogin): UsageSnapshot = withContext(Dispatchers.IO) {
        val authorization = pollForAuthorization(login)
        val response = transport.execute(
            HttpRequest(
                url = OAUTH_TOKEN_URL,
                method = "POST",
                headers = mapOf("Content-Type" to "application/x-www-form-urlencoded"),
                body = authorizationCodeForm(authorization.authorizationCode, authorization.codeVerifier),
            )
        )
        if (response.status !in 200..299) error("授权码交换失败（${response.status}）")
        val tokens = parseExchangedTokens(response.body)
        val stored = StoredCredentials(
            accessToken = tokens.accessToken,
            refreshToken = tokens.refreshToken,
            idToken = tokens.idToken,
            accountId = "",
        ).withAccountId()
        refreshMutex.withLock {
            // HttpURLConnection ignores cancellation until it returns.
            coroutineContext.ensureActive()
            credentials.save(stored)
        }
        refreshUsage()
    }

    suspend fun refreshUsage(): UsageSnapshot = refreshMutex.withLock {
        withContext(Dispatchers.IO) {
            val initial = credentials.load()?.withAccountId() ?: error("尚未登录")
            if (initial.accessToken.isBlank() || initial.refreshToken.isBlank()) error("尚未登录")
            if (initial.accountId.isBlank()) error("缺少 ChatGPT 账户标识，无法读取用量")
            var current = initial
            var response = transport.execute(usageRequest(current))
            if (response.status == 401) {
                current = refreshAfterUnauthorized(initial)
                response = transport.execute(usageRequest(current))
            }
            if (response.status == 401) error("登录已失效，请重新登录")
            if (response.status !in 200..299) error("读取用量失败（${response.status}）")
            val snapshot = parseUsagePayload(response.body, nowMillis() / 1000L)
            coroutineContext.ensureActive()
            usageCache.save(snapshot)
            snapshot
        }
    }

    suspend fun signOut() {
        refreshMutex.withLock {
            withContext(Dispatchers.IO) {
                credentials.clear()
                usageCache.clear()
            }
        }
    }

    private suspend fun pollForAuthorization(login: DeviceLogin): DeviceAuthorization {
        if (login.deviceAuthId.isBlank() || login.userCode.isBlank() || login.interval <= 0L) {
            error("设备码登录信息不完整")
        }
        while (true) {
            coroutineContext.ensureActive()
            if (nowMillis() - login.start >= DEVICE_LOGIN_TIMEOUT_MS) {
                error("设备码登录已超过 15 分钟，请重新获取验证码")
            }
            val response = transport.execute(
                HttpRequest(
                    url = DEVICE_TOKEN_URL,
                    method = "POST",
                    headers = mapOf("Content-Type" to "application/json"),
                    body = devicePollRequestBody(login.deviceAuthId, login.userCode),
                )
            )
            if (response.status in 200..299) return parseDeviceAuthorization(response.body)
            if (response.status == 403 || response.status == 404) {
                val remaining = DEVICE_LOGIN_TIMEOUT_MS - (nowMillis() - login.start)
                if (remaining <= 0L) error("设备码登录已超过 15 分钟，请重新获取验证码")
                sleepMillis(minOf(login.interval * 1000L, remaining))
                continue
            }
            error("设备码确认失败（${response.status}）")
        }
    }

    /** Caller already holds [refreshMutex]; locking again would deadlock. */
    private fun refreshAfterUnauthorized(seen: StoredCredentials): StoredCredentials {
        val latest = credentials.load()?.withAccountId() ?: error("尚未登录")
        if (latest.accessToken != seen.accessToken || latest.refreshToken != seen.refreshToken) return latest
        val response = transport.execute(
            HttpRequest(
                url = OAUTH_TOKEN_URL,
                method = "POST",
                headers = mapOf("Content-Type" to "application/json"),
                body = refreshTokenBody(latest.refreshToken),
            )
        )
        if (response.status !in 200..299) error(oauthFailureMessage(response.status, response.body))
        val updated = applyRefreshResponse(latest, response.body)
        credentials.save(updated)
        return updated
    }

    private fun usageRequest(stored: StoredCredentials) = HttpRequest(
        url = USAGE_URL,
        method = "GET",
        headers = mapOf(
            "Authorization" to "Bearer ${stored.accessToken}",
            "ChatGPT-Account-Id" to stored.accountId,
        ),
        followRedirects = true,
    )

    companion object {
        private val refreshMutex = Mutex()
    }
}
