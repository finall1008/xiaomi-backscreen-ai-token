package dev.finall.aitoken.work

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ListenableWorker.Result
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.finall.aitoken.bridge.RearCardBridgeClient
import dev.finall.aitoken.card.CardPackageBuilder
import dev.finall.aitoken.data.CodexRepository
import kotlinx.coroutines.CancellationException
import java.util.concurrent.TimeUnit

class UsageRefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        if (!isEnabled(applicationContext)) return Result.success()
        val repo = CodexRepository(applicationContext)
        if (!repo.isSignedIn()) return Result.success()
        return try {
            val snapshot = repo.refreshUsage()
            val bridge = RearCardBridgeClient(applicationContext)
            if (bridge.isConfigured()) {
                val file = CardPackageBuilder(applicationContext).export(snapshot, background = true)
                val reply = bridge.update(file)
                if (reply.getString("status") == "BINDING_REQUIRED") {
                    Log.w(TAG, "背屏尚未绑定，后台不打开界面")
                }
            }
            Result.success()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            // Do not Result.retry(): an expired login would otherwise back off forever.
            // The periodic interval is the only later attempt, and the last good cache stays.
            if (authFailure(error)) {
                Log.w(TAG, "登录已失效，停止本次重试，并保留上次成功的用量")
            } else {
                Log.w(TAG, "后台用量或背屏更新失败，已保留上次成功的用量（${error.javaClass.simpleName}）")
            }
            Result.failure()
        }
    }

    companion object {
        private const val TAG = "UsageRefresh"
        private const val PREFS = "usage-refresh"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_INTERVAL = "intervalMinutes"
        private const val UNIQUE_WORK = "codex-usage-refresh"
        private const val MIN_INTERVAL = 15L
        private const val DEFAULT_INTERVAL = 30L

        fun schedule(context: Context, enabled: Boolean, intervalMinutes: Long = DEFAULT_INTERVAL) {
            val minutes = intervalMinutes.coerceAtLeast(MIN_INTERVAL)
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_ENABLED, enabled)
                .putLong(KEY_INTERVAL, minutes)
                .apply()
            val manager = WorkManager.getInstance(context)
            if (!enabled) {
                manager.cancelUniqueWork(UNIQUE_WORK)
                return
            }
            val request = PeriodicWorkRequestBuilder<UsageRefreshWorker>(minutes, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            manager.enqueueUniquePeriodicWork(UNIQUE_WORK, ExistingPeriodicWorkPolicy.UPDATE, request)
        }

        fun isEnabled(context: Context): Boolean =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, false)

        fun intervalMinutes(context: Context): Long =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getLong(KEY_INTERVAL, DEFAULT_INTERVAL)
                .coerceAtLeast(MIN_INTERVAL)

        private fun authFailure(error: Throwable): Boolean {
            var current: Throwable? = error
            while (current != null) {
                val name = current.javaClass.name
                if (name.endsWith("AuthException") || name.endsWith("UnauthorizedException") ||
                    name.endsWith("AuthFailureException") || name.contains("NotAuthenticated")) {
                    return true
                }
                val message = current.message.orEmpty()
                if (message.contains("401") ||
                    message.contains("invalid_grant", ignoreCase = true) ||
                    message.contains("unauthorized", ignoreCase = true) ||
                    message.contains("登录已失效") ||
                    message.contains("尚未登录") ||
                    message.contains("身份验证失败") ||
                    message.contains("刷新令牌")) {
                    return true
                }
                current = current.cause
            }
            return false
        }
    }
}
