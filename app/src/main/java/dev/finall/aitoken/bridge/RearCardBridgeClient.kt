package dev.finall.aitoken.bridge

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

class RearCardBridgeClient(private val context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isConfigured(): Boolean = prefs.getBoolean(KEY_CONFIGURED, false)

    fun recordForegroundResult(result: Intent?) {
        if (result?.getStringExtra("key") != KEY) return
        when (result.getStringExtra("status")) {
            "SAVED", "CARRIER_WRITTEN", "SETTINGS_OPENED" -> {
                if (!result.getStringExtra("card_id").isNullOrBlank()) {
                    prefs.edit().putBoolean(KEY_CONFIGURED, true).apply()
                }
            }
            "BINDING_REQUIRED" -> prefs.edit().putBoolean(KEY_CONFIGURED, false).apply()
        }
    }

    fun foregroundIntent(file: File): Intent {
        val uri = fileUri(file)
        return Intent(ACTION_UPDATE).apply {
            setPackage(PACKAGE)
            setDataAndType(uri, "application/zip")
            clipData = ClipData.newRawUri("Codex 用量背屏卡片", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            putExtra("api_version", 2)
            putExtra("request_id", requestId())
            putExtra("key", KEY)
        }
    }

    suspend fun update(file: File): Bundle = withContext(Dispatchers.IO) {
        val uri = fileUri(file)
        context.grantUriPermission(PACKAGE, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            val result = context.contentResolver.call(
                Uri.parse("content://$PACKAGE.update"),
                "update_content",
                null,
                Bundle().apply {
                    putInt("api_version", 2)
                    putParcelable("package_uri", uri)
                    putString("request_id", requestId())
                    putString("key", KEY)
                },
            ) ?: error("背屏卡片桥未返回更新结果")
            when (result.getString("status")) {
                "SAVED" -> prefs.edit().putBoolean(KEY_CONFIGURED, true).apply()
                // Background callers must keep this result and must not open a configuration UI.
                "BINDING_REQUIRED" -> prefs.edit().putBoolean(KEY_CONFIGURED, false).apply()
                else -> error(result.getString("message") ?: "背屏更新失败：${result.getString("status")}")
            }
            result
        } catch (error: IllegalArgumentException) {
            throw IllegalStateException("无法调用背屏卡片桥 v2，请确认已安装支持 v2 的版本", error)
        } finally {
            context.revokeUriPermission(PACKAGE, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    private fun fileUri(file: File): Uri =
        FileProvider.getUriForFile(context, "${context.packageName}.files", file)

    companion object {
        const val PACKAGE = "dev.finall.rearcardbridge"
        const val KEY = "codex-usage"
        private const val PREFS = "rear-card-bridge"
        private const val KEY_CONFIGURED = "configured"
        private const val ACTION_UPDATE = "dev.finall.rearcardbridge.action.UPDATE_CONTENT"

        fun requestId(): String = "codex-${UUID.randomUUID()}"
    }
}
