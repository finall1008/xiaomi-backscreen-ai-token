package dev.finall.aitoken.ui

import android.content.Context
import android.net.Uri
import dev.finall.aitoken.BuildConfig
import java.io.File

/** Fixed event names and numeric metrics only: never URLs, page text or credentials. */
internal class MimoWebDiagnostics(context: Context) {
    private val file = File(context.noBackupFilesDir, "mimo-web-events.txt")

    init {
        if (BuildConfig.DEBUG) file.writeText("session-start\n")
    }

    fun event(name: String, url: String? = null, metrics: String = "") {
        if (!BuildConfig.DEBUG) return
        val host = runCatching { Uri.parse(url.orEmpty()).host }.getOrNull()
        val origin = when (host) {
            "account.xiaomi.com" -> "passport"
            "platform.xiaomimimo.com" -> "platform"
            null -> "none"
            else -> "other"
        }
        // Metrics are caller-generated numeric values, not raw console/DOM/network text.
        file.appendText("${System.currentTimeMillis()} $name $origin $metrics\n")
    }
}
