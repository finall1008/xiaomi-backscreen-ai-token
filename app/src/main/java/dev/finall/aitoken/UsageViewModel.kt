package dev.finall.aitoken

import android.app.Application
import android.content.Intent
import android.webkit.CookieManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.finall.aitoken.bridge.RearCardBridgeClient
import dev.finall.aitoken.card.CardPackageBuilder
import dev.finall.aitoken.data.ProviderRepository
import dev.finall.aitoken.model.DeviceLogin
import dev.finall.aitoken.model.ProviderAuthException
import dev.finall.aitoken.model.ProviderCardEntry
import dev.finall.aitoken.model.ProviderId
import dev.finall.aitoken.model.ProviderSnapshot
import dev.finall.aitoken.work.UsageRefreshWorker
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

data class ProviderUiState(
    val configured: Boolean = false,
    val snapshot: ProviderSnapshot? = null,
    val authExpired: Boolean = false,
)

data class UsageUiState(
    val screen: Screen = Screen.Home,
    val providers: Map<ProviderId, ProviderUiState> = ProviderId.entries.associateWith { ProviderUiState() },
    val previewUrl: String? = null,
    val autoRefresh: Boolean = false,
    val intervalMinutes: Long = 30,
    val busy: Boolean = false,
    val status: String = "尚未设置用量来源",
    val login: DeviceLogin? = null,
)

class UsageViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = ProviderRepository(app)
    private val cards = CardPackageBuilder(app)
    private val bridge = RearCardBridgeClient(app)
    private val mutableState = MutableStateFlow(UsageUiState())
    val state = mutableState.asStateFlow()
    private var operation: Job? = null

    init {
        resume()
    }

    fun openProvider(id: ProviderId) {
        mutableState.value = mutableState.value.copy(screen = Screen.ProviderDetail(id))
    }

    fun back() {
        mutableState.value = mutableState.value.copy(screen = Screen.Home)
    }

    fun resume() {
        if (mutableState.value.busy) return
        runOperation {
            val loaded = withContext(Dispatchers.IO) {
                val configured = repo.configured().toSet()
                val snapshots = ProviderId.entries.associateWith { id ->
                    if (id in configured) repo.cachedSnapshot(id) else null
                }
                configured to snapshots
            }
            val configured = loaded.first
            val snapshots = loaded.second
            val entries = ProviderId.entries
                .filter { it in configured }
                .map { id -> ProviderCardEntry(id, snapshots[id]) }
            val preview = if (entries.isEmpty()) null else cards.preview(entries)
            val previous = mutableState.value
            val providers = ProviderId.entries.associateWith { id ->
                ProviderUiState(
                    configured = id in configured,
                    snapshot = snapshots[id],
                    authExpired = previous.providers[id]?.authExpired == true && id in configured,
                )
            }
            mutableState.value = previous.copy(
                providers = providers,
                previewUrl = preview,
                autoRefresh = UsageRefreshWorker.isEnabled(getApplication()),
                intervalMinutes = UsageRefreshWorker.intervalMinutes(getApplication()),
                status = if (configured.isEmpty()) "尚未设置用量来源" else "用量为最近成功读取的缓存",
            )
        }
    }

    fun codexConnect() = runOperation {
        val login = repo.codex().requestDeviceCode()
        mutableState.value = mutableState.value.copy(
            login = login,
            status = "请在 OpenAI 官方网页输入验证码，15 分钟内完成",
        )
        repo.codex().completeDeviceLogin(login)
        mutableState.value = mutableState.value.copy(login = null)
        updateProvider(ProviderId.CODEX) { it.copy(configured = true, authExpired = false) }
        applyRefresh(ProviderId.CODEX, "登录成功，用量已刷新")
    }

    fun cancelLogin() {
        operation?.cancel()
        mutableState.value = mutableState.value.copy(login = null, status = "已取消登录")
    }

    fun codexSignOut() = clearProvider(ProviderId.CODEX)

    fun saveSecret(id: ProviderId, secret: String) = runOperation {
        val value = secret.trim().replace("\r", "").replace("\n", "")
        if (value.isEmpty()) {
            setStatus("请输入凭据")
            return@runOperation
        }
        withContext(Dispatchers.IO) { repo.saveSecret(id, value) }
        updateProvider(id) { it.copy(configured = true, authExpired = false) }
        applyRefresh(id, "已保存并刷新")
    }

    fun refreshProvider(id: ProviderId) = runOperation {
        applyRefresh(id, "用量已刷新")
    }

    fun clearProvider(id: ProviderId) = runOperation {
        withContext(Dispatchers.IO) { repo.clear(id) }
        if (id == ProviderId.MIMO) {
            withContext(Dispatchers.Main) {
                runCatching { CookieManager.getInstance().removeAllCookies(null) }
            }
        }
        updateProvider(id) { ProviderUiState() }
        if (id == ProviderId.CODEX) {
            mutableState.value = mutableState.value.copy(login = null)
        }
        reloadPreview()
        setStatus(
            if (id == ProviderId.CODEX) "已退出登录；背屏保留最后一次保存的卡片" else "已清除凭据",
        )
    }

    fun publish(launch: (Intent) -> Unit) = runOperation {
        val entries = withContext(Dispatchers.IO) { repo.cachedEntries() }
        if (entries.isEmpty()) {
            setStatus("请先设置至少一个用量来源")
            return@runOperation
        }
        val file = cards.export(entries)
        if (bridge.isConfigured()) {
            val result = bridge.update(file)
            if (result.getString("status") == "SAVED") {
                setStatus("背屏内容已保存，休眠时会在点亮后载入")
                return@runOperation
            }
        }
        try {
            launch(bridge.foregroundIntent(file))
        } catch (_: android.content.ActivityNotFoundException) {
            setStatus("请先安装支持 v2 的背屏卡片桥")
            return@runOperation
        }
        setStatus("请在背屏卡片桥完成绑定，并在系统中重新应用一次")
    }

    fun export(ready: (File) -> Unit) = runOperation {
        val entries = withContext(Dispatchers.IO) { repo.cachedEntries() }
        if (entries.isEmpty()) error("暂无用量可导出")
        ready(cards.export(entries))
    }

    fun bridgeResult(intent: Intent?) {
        bridge.recordForegroundResult(intent)
        setStatus(
            when (intent?.getStringExtra("status")) {
                "SAVED" -> "背屏内容已保存"
                "CARRIER_WRITTEN" -> "载体已写入，请在系统背屏设置重新应用卡片"
                "BINDING_REQUIRED" -> "内容已暂存，请完成背屏绑定"
                "SETTINGS_OPENED" -> "背屏设置已打开，请确认应用卡片"
                else -> intent?.getStringExtra("message") ?: "桥接操作已结束"
            },
        )
    }

    fun setAutomatic(enabled: Boolean, minutes: Long) {
        if (mutableState.value.busy) return
        if (minutes < 15) {
            setStatus("刷新间隔至少为 15 分钟")
            return
        }
        if (enabled && mutableState.value.providers.values.none { it.configured }) {
            setStatus("请先设置至少一个用量来源")
            return
        }
        UsageRefreshWorker.schedule(getApplication(), enabled, minutes)
        mutableState.value = mutableState.value.copy(autoRefresh = enabled, intervalMinutes = minutes)
        setStatus(if (enabled) "后台刷新已开启，实际执行时间由系统省电策略决定" else "后台刷新已关闭")
    }

    fun setStatus(message: String) {
        mutableState.value = mutableState.value.copy(status = message)
    }

    private suspend fun applyRefresh(id: ProviderId, success: String) {
        try {
            val snapshot = withContext(Dispatchers.IO) { repo.refresh(id) }
            updateProvider(id) { it.copy(configured = true, snapshot = snapshot, authExpired = false) }
            reloadPreview()
            setStatus(success)
        } catch (error: ProviderAuthException) {
            updateProvider(id) { it.copy(configured = true, authExpired = true) }
            setStatus(error.message?.takeIf { it.isNotBlank() } ?: "授权已过期，请重新设置")
        }
    }

    private suspend fun reloadPreview() {
        val entries = withContext(Dispatchers.IO) { repo.cachedEntries() }
        val url = if (entries.isEmpty()) null else cards.preview(entries)
        mutableState.value = mutableState.value.copy(previewUrl = url)
    }

    private fun updateProvider(id: ProviderId, transform: (ProviderUiState) -> ProviderUiState) {
        val current = mutableState.value
        val providers = current.providers.toMutableMap()
        providers[id] = transform(providers[id] ?: ProviderUiState())
        mutableState.value = current.copy(providers = providers)
    }

    private fun runOperation(block: suspend () -> Unit) {
        if (mutableState.value.busy) return
        mutableState.value = mutableState.value.copy(busy = true)
        operation = viewModelScope.launch {
            try {
                block()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                mutableState.value = mutableState.value.copy(
                    login = null,
                    status = error.message?.takeIf { it.isNotBlank() } ?: "操作失败，请重试",
                )
            } finally {
                mutableState.value = mutableState.value.copy(busy = false)
            }
        }
    }
}
