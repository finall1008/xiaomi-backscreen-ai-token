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
import dev.finall.aitoken.data.ProviderRepository
import dev.finall.aitoken.model.ProviderAuthException
import kotlinx.coroutines.CancellationException
import java.util.concurrent.TimeUnit

class UsageRefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        if (!isEnabled(applicationContext)) return Result.success()
        val repo = ProviderRepository(applicationContext)
        val ids = repo.configured()
        if (ids.isEmpty()) return Result.success()
        for (id in ids) {
            val outcome = runCatching { repo.refresh(id) }
            val error = outcome.exceptionOrNull()
            if (error is CancellationException) throw error
            if (outcome.isSuccess) {
                AuthNotifier.reset(applicationContext, id)
                continue
            }
            when (error) {
                is ProviderAuthException -> {
                    Log.w(TAG, "${id.wire} 授权已过期，保留上次成功数据")
                    AuthNotifier.notifyAuthExpired(applicationContext, id)
                }
                else -> Log.w(TAG, "${id.wire} 刷新失败，继续其他来源（${error?.javaClass?.simpleName}）")
            }
        }
        val bridge = RearCardBridgeClient(applicationContext)
        if (ids.isNotEmpty() && bridge.isConfigured()) {
            try {
                val file = CardPackageBuilder(applicationContext).export(repo.cachedEntries(), background = true)
                val reply = bridge.update(file)
                if (reply.getString("status") == "BINDING_REQUIRED") {
                    Log.w(TAG, "背屏尚未绑定，后台不打开界面")
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Log.w(TAG, "后台背屏更新失败，已保留上次成功的用量（${error.javaClass.simpleName}）")
            }
        }
        return Result.success()
    }

    companion object {
        private const val TAG = "UsageRefresh"
        private const val PREFS = "usage-refresh"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_INTERVAL = "intervalMinutes"
        private const val UNIQUE_WORK = "provider-usage-refresh"
        private const val LEGACY_WORK = "codex-usage-refresh"
        private const val MIN_INTERVAL = 15L
        private const val DEFAULT_INTERVAL = 30L

        fun schedule(context: Context, enabled: Boolean, intervalMinutes: Long = DEFAULT_INTERVAL) {
            val minutes = intervalMinutes.coerceAtLeast(MIN_INTERVAL)
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_ENABLED, enabled)
                .putLong(KEY_INTERVAL, minutes)
                .apply()
            val manager = WorkManager.getInstance(context)
            manager.cancelUniqueWork(LEGACY_WORK)
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
    }
}
