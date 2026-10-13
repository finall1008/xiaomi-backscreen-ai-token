package dev.finall.aitoken

import android.app.Application
import android.content.Intent
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.finall.aitoken.bridge.RearCardBridgeClient
import dev.finall.aitoken.card.CardPackageBuilder
import dev.finall.aitoken.data.CodexRepository
import dev.finall.aitoken.model.DeviceLogin
import dev.finall.aitoken.model.UsageSnapshot
import dev.finall.aitoken.work.UsageRefreshWorker
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

 data class UsageUiState(
    val signedIn: Boolean = false,
    val usage: UsageSnapshot? = null,
    val previewUrl: String? = null,
    val login: DeviceLogin? = null,
    val busy: Boolean = false,
    val status: String = "尚未连接 OpenAI",
    val autoRefresh: Boolean = false,
    val intervalMinutes: Long = 30,
)

class UsageViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = CodexRepository(app)
    private val cards = CardPackageBuilder(app)
    private val bridge = RearCardBridgeClient(app)
    private val mutableState = MutableStateFlow(UsageUiState())
    val state = mutableState.asStateFlow()
    private var operation: Job? = null

    init { resume() }

    fun resume() {
        if (mutableState.value.busy) return
        runOperation {
            val cached = withContext(Dispatchers.IO) { repo.cachedUsage() }
            val signedIn = withContext(Dispatchers.IO) { repo.isSignedIn() }
            mutableState.value = mutableState.value.copy(
                signedIn = signedIn, usage = cached,
                previewUrl = cached?.let { cards.preview(it) },
                autoRefresh = UsageRefreshWorker.isEnabled(getApplication()),
                intervalMinutes = UsageRefreshWorker.intervalMinutes(getApplication()),
                status = if (signedIn) "已连接 · 用量为最近成功读取的缓存" else "尚未连接 OpenAI",
            )
        }
    }

    fun connect() = runOperation {
        val login = repo.requestDeviceCode()
        mutableState.value = mutableState.value.copy(login = login, status = "请在 OpenAI 官方网页输入验证码，15 分钟内完成")
        val usage = repo.completeDeviceLogin(login)
        mutableState.value = mutableState.value.copy(login = null, signedIn = true)
        showUsage(usage)
        setStatus("登录成功，用量已刷新")
    }

    fun cancelLogin() {
        operation?.cancel()
        mutableState.value = mutableState.value.copy(login = null, status = "已取消登录")
    }

    fun refresh() = runOperation {
        showUsage(repo.refreshUsage())
        setStatus("用量已刷新")
        if (bridge.isConfigured()) {
            val result = bridge.update(cards.export(requireNotNull(mutableState.value.usage)))
            setStatus(if (result.getString("status") == "SAVED") "用量已刷新，背屏内容已保存" else "用量已刷新，请重新绑定背屏")
        }
    }

    private suspend fun showUsage(usage: UsageSnapshot) {
        mutableState.value = mutableState.value.copy(usage = usage, signedIn = true, previewUrl = cards.preview(usage))
    }

    fun publish(launch: (Intent) -> Unit) = runOperation {
        val snapshot = mutableState.value.usage ?: error("请先登录并刷新用量")
        val file = cards.export(snapshot)
        if (bridge.isConfigured()) {
            val result = bridge.update(file)
            if (result.getString("status") == "SAVED") { setStatus("背屏内容已保存，休眠时会在点亮后载入"); return@runOperation }
        }
        launch(bridge.foregroundIntent(file))
        setStatus("请在背屏卡片桥完成绑定，并在系统中重新应用一次")
    }

    fun export(ready: (File) -> Unit) = runOperation {
        ready(cards.export(mutableState.value.usage ?: error("暂无用量可导出")))
    }

    fun bridgeResult(intent: Intent?) {
        bridge.recordForegroundResult(intent)
        setStatus(when (intent?.getStringExtra("status")) {
            "SAVED" -> "背屏内容已保存"
            "CARRIER_WRITTEN" -> "载体已写入，请在系统背屏设置重新应用卡片"
            "BINDING_REQUIRED" -> "内容已暂存，请完成背屏绑定"
            "SETTINGS_OPENED" -> "背屏设置已打开，请确认应用卡片"
            else -> intent?.getStringExtra("message") ?: "桥接操作已结束"
        })
    }

    fun setAutomatic(enabled: Boolean, minutes: Long) {
        if (minutes < 15) { setStatus("刷新间隔至少为 15 分钟"); return }
        UsageRefreshWorker.schedule(getApplication(), enabled, minutes)
        mutableState.value = mutableState.value.copy(autoRefresh = enabled, intervalMinutes = minutes)
        setStatus(if (enabled) "后台刷新已开启，实际执行时间由系统省电策略决定" else "后台刷新已关闭")
    }

    fun signOut() = runOperation {
        UsageRefreshWorker.schedule(getApplication(), false, mutableState.value.intervalMinutes)
        repo.signOut()
        mutableState.value = UsageUiState(busy = true, status = "已退出登录；背屏保留最后一次保存的卡片")
    }

    fun setStatus(message: String) { mutableState.value = mutableState.value.copy(status = message) }

    private fun runOperation(block: suspend () -> Unit) {
        if (mutableState.value.busy) return
        mutableState.value = mutableState.value.copy(busy = true)
        operation = viewModelScope.launch {
            try { block() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                val signedIn = withContext(Dispatchers.IO) { repo.isSignedIn() }
                mutableState.value = mutableState.value.copy(signedIn = signedIn, login = null, status = e.message ?: "操作失败，请重试")
            } finally { mutableState.value = mutableState.value.copy(busy = false) }
        }
    }
}
