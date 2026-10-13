package dev.finall.aitoken.data

import android.content.Context
import dev.finall.aitoken.model.ProviderAuthException
import dev.finall.aitoken.model.ProviderCardEntry
import dev.finall.aitoken.model.ProviderId
import dev.finall.aitoken.model.ProviderSnapshot
import dev.finall.aitoken.model.ProviderWindow
import dev.finall.aitoken.model.UsageSnapshot
import dev.finall.aitoken.model.parseCachedProviderSnapshot
import dev.finall.aitoken.model.toCacheJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import java.io.File
import java.io.FileOutputStream

class ProviderRepository(private val context: Context) {
    private val codexRepository = CodexRepository(context)
    private val transport = HttpUrlConnectionTransport()
    private val kimiClient = KimiClient(transport) { endpoint, shape ->
        if (dev.finall.aitoken.BuildConfig.DEBUG) {
            File(context.noBackupFilesDir, "kimi-$endpoint-shape.json").writeText(shape)
        }
    }
    private val deepSeekClient = DeepSeekClient(transport)
    private val mimoClient = MimoClient(transport) { endpoint, shape ->
        if (dev.finall.aitoken.BuildConfig.DEBUG) {
            File(context.noBackupFilesDir, "mimo-$endpoint-shape.json").writeText(shape)
        }
    }
    private val secrets = mapOf(
        ProviderId.KIMI to EncryptedFileStore(context, "secret-kimi.bin", "dev.finall.aitoken.kimi"),
        ProviderId.DEEPSEEK to EncryptedFileStore(context, "secret-deepseek.bin", "dev.finall.aitoken.deepseek"),
        ProviderId.MIMO to EncryptedFileStore(context, "secret-mimo.bin", "dev.finall.aitoken.mimo"),
    )

    fun configured(): List<ProviderId> = ProviderId.entries.filter { isConfigured(it) }

    fun isConfigured(id: ProviderId): Boolean = locked(id) {
        when (id) {
            ProviderId.CODEX -> codexRepository.isSignedIn()
            ProviderId.KIMI, ProviderId.DEEPSEEK, ProviderId.MIMO ->
                !secrets.getValue(id).load().isNullOrBlank()
        }
    }

    fun cachedSnapshot(id: ProviderId): ProviderSnapshot? = locked(id) {
        val file = cacheFile(id)
        if (!file.isFile) {
            null
        } else {
            val text = runCatching { file.readText(Charsets.UTF_8) }.getOrNull()
            if (text == null) null else parseCachedProviderSnapshot(text)?.takeIf { it.id == id }
        }
    }

    fun cachedEntries(): List<ProviderCardEntry> =
        configured().map { id -> ProviderCardEntry(id, cachedSnapshot(id)) }

    fun refresh(id: ProviderId): ProviderSnapshot = locked(id) {
        val snapshot = when (id) {
            ProviderId.CODEX -> refreshCodex()
            ProviderId.KIMI, ProviderId.DEEPSEEK, ProviderId.MIMO -> refreshApi(id)
        }
        writeCache(id, snapshot)
        snapshot
    }

    fun saveSecret(id: ProviderId, secret: String) {
        if (id == ProviderId.CODEX) {
            throw UnsupportedOperationException("Codex 使用设备码登录，不能直接保存密钥")
        }
        locked(id) { secrets.getValue(id).save(secret) }
    }

    fun clear(id: ProviderId) = locked(id) {
        if (id == ProviderId.CODEX) {
            runBlocking { codexRepository.signOut() }
        } else {
            secrets.getValue(id).clear()
        }
        val file = cacheFile(id)
        file.delete()
        File(file.parentFile, file.name + ".tmp").delete()
    }

    fun codex(): CodexRepository = codexRepository

    private fun refreshCodex(): ProviderSnapshot {
        val usage = try {
            runBlocking { codexRepository.refreshUsage() }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: ProviderAuthException) {
            throw error
        } catch (error: Exception) {
            if (isAuthFailure(error)) {
                throw ProviderAuthException(error.message?.takeIf { it.isNotBlank() } ?: "登录已失效，请重新登录")
            }
            throw error
        }
        return usage.toProviderSnapshot()
    }

    private fun refreshApi(id: ProviderId): ProviderSnapshot {
        val secret = secrets.getValue(id).load()?.takeIf { it.isNotBlank() }
            ?: throw Exception("尚未设置")
        val nowSeconds = System.currentTimeMillis() / 1000L
        return when (id) {
            ProviderId.KIMI -> kimiClient.fetch(secret, nowSeconds)
            ProviderId.DEEPSEEK -> deepSeekClient.fetch(secret, nowSeconds)
            ProviderId.MIMO -> mimoClient.fetch(secret, nowSeconds)
            ProviderId.CODEX -> throw UnsupportedOperationException("Codex 使用设备码登录，不能直接保存密钥")
        }
    }

    private fun writeCache(id: ProviderId, snapshot: ProviderSnapshot) {
        writeAtomic(cacheFile(id), snapshot.toCacheJson().toByteArray(Charsets.UTF_8))
    }

    private fun cacheFile(id: ProviderId): File {
        val dir = context.noBackupFilesDir.apply { mkdirs() }
        return File(dir, "usage-${id.wire}.json")
    }

    private inline fun <T> locked(id: ProviderId, block: () -> T): T =
        synchronized(locks.getValue(id)) { block() }

    companion object {
        private val locks: Map<ProviderId, Any> = ProviderId.entries.associateWith { Any() }
    }
}

internal fun UsageSnapshot.toProviderSnapshot(): ProviderSnapshot {
    val windows = buildList {
        primary?.let { window ->
            add(ProviderWindow("5 小时限额", window.usedPercent, FIVE_HOUR_SECONDS, window.resetAt))
        }
        secondary?.let { window ->
            add(ProviderWindow("本周限额", window.usedPercent, WEEK_SECONDS, window.resetAt))
        }
    }
    val hint = if (primary == null && secondary != null) "当前套餐无 5 小时限额" else null
    return ProviderSnapshot(
        id = ProviderId.CODEX,
        plan = planType,
        updatedAt = updatedAt,
        windows = windows,
        balance = null,
        credits = null,
        booster = null,
        hint = hint,
    )
}

private fun isAuthFailure(error: Throwable): Boolean {
    var current: Throwable? = error
    while (current != null) {
        val name = current.javaClass.name
        if (name.endsWith("AuthException") || name.endsWith("UnauthorizedException") ||
            name.endsWith("AuthFailureException") || name.contains("NotAuthenticated")
        ) {
            return true
        }
        val message = current.message.orEmpty()
        if (message.contains("401") ||
            message.contains("invalid_grant", ignoreCase = true) ||
            message.contains("unauthorized", ignoreCase = true) ||
            message.contains("登录已失效") ||
            message.contains("尚未登录") ||
            message.contains("身份验证失败") ||
            message.contains("刷新令牌")
        ) {
            return true
        }
        current = current.cause
    }
    return false
}

private fun writeAtomic(destination: File, bytes: ByteArray) {
    destination.parentFile?.mkdirs()
    val temporary = File(destination.parentFile, destination.name + ".tmp")
    FileOutputStream(temporary).use { output ->
        output.write(bytes)
        output.fd.sync()
    }
    if (!temporary.renameTo(destination)) {
        temporary.copyTo(destination, overwrite = true)
        temporary.delete()
    }
}

private const val FIVE_HOUR_SECONDS = 5L * 3600L
private const val WEEK_SECONDS = 7L * 24L * 3600L
