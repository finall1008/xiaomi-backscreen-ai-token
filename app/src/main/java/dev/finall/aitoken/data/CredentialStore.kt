package dev.finall.aitoken.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import dev.finall.aitoken.model.UsageSnapshot
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class StoredCredentials(
    val accessToken: String,
    val refreshToken: String,
    val idToken: String,
    val accountId: String,
) {
    override fun toString(): String = "StoredCredentials(redacted)"
}

internal interface CredentialStore {
    fun load(): StoredCredentials?
    fun save(credentials: StoredCredentials)
    fun clear()
}

internal interface UsageCache {
    fun load(): UsageSnapshot?
    fun save(snapshot: UsageSnapshot)
    fun clear()
}

internal class AndroidCredentialStore(context: Context) : CredentialStore {
    private val file = File(context.noBackupFilesDir.apply { mkdirs() }, FILE_NAME)

    override fun load(): StoredCredentials? = synchronized(lock) {
        if (!file.isFile) return null
        try {
            val plain = decrypt(file.readBytes())
            parseStored(String(plain, Charsets.UTF_8))?.withAccountId()
        } catch (_: Exception) {
            null
        }
    }

    override fun save(credentials: StoredCredentials) = synchronized(lock) {
        val healed = credentials.withAccountId()
        val json = JSONObject()
            .put("accessToken", healed.accessToken)
            .put("refreshToken", healed.refreshToken)
            .put("idToken", healed.idToken)
            .put("accountId", healed.accountId)
            .toString()
        writeAtomic(file, encrypt(json.toByteArray(Charsets.UTF_8)))
    }

    override fun clear() {
        synchronized(lock) {
            file.delete()
            File(file.parentFile, file.name + ".tmp").delete()
            runCatching {
                val keyStore = keyStore()
                if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS)
            }
        }
    }

    private fun encrypt(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val iv = cipher.iv
        val encrypted = cipher.doFinal(plain)
        return byteArrayOf(iv.size.toByte()) + iv + encrypted
    }

    private fun decrypt(payload: ByteArray): ByteArray {
        if (payload.isEmpty()) error("empty")
        val ivLength = payload[0].toInt() and 0xff
        if (ivLength !in 12..16 || payload.size <= 1 + ivLength + 16) error("short")
        val iv = payload.copyOfRange(1, 1 + ivLength)
        val encrypted = payload.copyOfRange(1 + ivLength, payload.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
        return cipher.doFinal(encrypted)
    }

    private fun secretKey(): SecretKey {
        val keyStore = keyStore()
        val existing = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build()
        generator.init(spec)
        return generator.generateKey()
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    companion object {
        private val lock = Any()
        private const val FILE_NAME = "codex-credentials.bin"
        private const val KEY_ALIAS = "dev.finall.aitoken.codex"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}

internal class FileUsageCache(context: Context) : UsageCache {
    private val file = File(context.noBackupFilesDir.apply { mkdirs() }, FILE_NAME)

    override fun load(): UsageSnapshot? = synchronized(lock) {
        if (!file.isFile) return null
        val text = runCatching { file.readText(Charsets.UTF_8) }.getOrNull() ?: return null
        parseCachedUsage(text)
    }

    override fun save(snapshot: UsageSnapshot) = synchronized(lock) {
        writeAtomic(file, snapshot.toCacheJson().toByteArray(Charsets.UTF_8))
    }

    override fun clear() {
        synchronized(lock) {
            file.delete()
            File(file.parentFile, file.name + ".tmp").delete()
        }
    }

    companion object {
        private val lock = Any()
        private const val FILE_NAME = "codex-usage.json"
    }
}

private fun parseStored(text: String): StoredCredentials? {
    val json = try {
        JSONObject(text)
    } catch (_: Exception) {
        return null
    }
    val access = json.optString("accessToken")
    val refresh = json.optString("refreshToken")
    if (access.isBlank() || refresh.isBlank()) return null
    return StoredCredentials(
        accessToken = access,
        refreshToken = refresh,
        idToken = json.optString("idToken"),
        accountId = json.optString("accountId"),
    )
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
