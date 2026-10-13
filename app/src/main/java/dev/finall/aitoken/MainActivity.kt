package dev.finall.aitoken

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import dev.finall.aitoken.ui.UsageScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class MainActivity : ComponentActivity() {
    private val model: UsageViewModel by viewModels()
    private var pendingExport: File? = null
    private val bridge = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result -> model.bridgeResult(result.data) }
    private val export = registerForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        val file = pendingExport
        pendingExport = null
        if (uri != null && file != null) lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    contentResolver.openOutputStream(uri)?.use { output -> file.inputStream().use { it.copyTo(output) } } ?: error("无法写入文件")
                }
                model.setStatus("卡片 ZIP 已导出")
            } catch (_: Exception) { model.setStatus("导出失败，请重试") }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            UsageScreen(
                state = model.state.collectAsStateWithLifecycle().value,
                onConnect = model::connect,
                onCancelLogin = model::cancelLogin,
                onRefresh = model::refresh,
                onPublish = { model.publish { intent ->
                    try { bridge.launch(intent) }
                    catch (_: android.content.ActivityNotFoundException) { model.setStatus("请先安装支持 v2 的背屏卡片桥") }
                } },
                onExport = { model.export { pendingExport = it; export.launch("codex-usage.zip") } },
                onAutomatic = model::setAutomatic,
                onSignOut = model::signOut,
                onMessage = model::setStatus,
            )
        }
    }
    override fun onResume() { super.onResume(); model.resume() }
}
