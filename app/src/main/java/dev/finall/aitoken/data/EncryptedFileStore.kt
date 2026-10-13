package dev.finall.aitoken.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class EncryptedFileStore(
    context: Context,
    fileName: String,
    private val keyAlias: String,
) {
    private val file = File(context.noBackupFilesDir.apply { mkdirs() }, fileName)

    fun load(): String? = locked {
        if (!file.isFile) return@locked null
        try {
            String(decrypt(file.readBytes()), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    fun save(value: String) = locked {
        writeAtomic(file, encrypt(value.toByteArray(Charsets.UTF_8)))
    }

    fun clear() = locked {
        file.delete()
        File(file.parentFile, file.name + ".tmp").delete()
        runCatching {
            val keyStore = keyStore()
            if (keyStore.containsAlias(keyAlias)) keyStore.deleteEntry(keyAlias)
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
        val existing = keyStore.getKey(keyAlias, null) as? SecretKey
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            keyAlias,
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

    private inline fun <T> locked(block: () -> T): T {
        val lock = locks.getOrPut(keyAlias) { Any() }
        return synchronized(lock) { block() }
    }

    companion object {
        private val locks = ConcurrentHashMap<String, Any>()
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
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
