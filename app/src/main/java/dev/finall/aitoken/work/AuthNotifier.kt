package dev.finall.aitoken.work

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import dev.finall.aitoken.MainActivity
import dev.finall.aitoken.R
import dev.finall.aitoken.model.ProviderId

object AuthNotifier {
    private const val CHANNEL_ID = "auth-expired"
    private const val CHANNEL_NAME = "登录失效提醒"
    private const val PREFS = "auth-notify"
    private const val BODY = "点击打开 App 重新登录，背屏将保留最后成功数据"

    fun notifyAuthExpired(context: Context, id: ProviderId) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val key = notifiedKey(id)
        if (prefs.getBoolean(key, false)) return
        prefs.edit().putBoolean(key, true).commit()
        if (!canPostNotifications(context)) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        ensureChannel(manager)
        manager.notify(id.ordinal, notification(context, id))
    }

    fun reset(context: Context, id: ProviderId) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(notifiedKey(id))
            .apply()
        context.getSystemService(NotificationManager::class.java)?.cancel(id.ordinal)
    }

    private fun notifiedKey(id: ProviderId): String = "notified-${id.wire}"

    private fun canPostNotifications(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun ensureChannel(manager: NotificationManager) {
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    private fun notification(context: Context, id: ProviderId) =
        NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(smallIcon(context))
            .setContentTitle("${displayName(id)} 授权已过期")
            .setContentText(BODY)
            .setStyle(NotificationCompat.BigTextStyle().bigText(BODY))
            .setAutoCancel(true)
            .setContentIntent(openApp(context, id))
            .build()

    private fun smallIcon(context: Context): Int {
        val launcher = context.applicationInfo.icon
        return if (launcher != 0) launcher else R.mipmap.ic_launcher
    }

    private fun openApp(context: Context, id: ProviderId): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            putExtra("provider", id.wire)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        return PendingIntent.getActivity(
            context,
            id.ordinal,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun displayName(id: ProviderId): String = when (id) {
        ProviderId.CODEX -> "Codex"
        ProviderId.KIMI -> "Kimi Code"
        ProviderId.DEEPSEEK -> "DeepSeek"
        ProviderId.MIMO -> "小米 MiMo"
    }
}
