package dev.finall.aitoken

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import dev.finall.aitoken.model.ProviderId
import dev.finall.aitoken.ui.UsageScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class MainActivity : ComponentActivity() {
    private val model: UsageViewModel by viewModels()
    private var pendingExport: File? = null
    private val bridge = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        model.bridgeResult(result.data)
    }
    private val export = registerForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        val file = pendingExport
        pendingExport = null
        if (uri != null && file != null) lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    contentResolver.openOutputStream(uri)?.use { output ->
                        file.inputStream().use { it.copyTo(output) }
                    } ?: error("无法写入文件")
                }
                model.setStatus("卡片 ZIP 已导出")
            } catch (_: Exception) {
                model.setStatus("导出失败，请重试")
            }
        }
    }
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            UsageScreen(
                state = model.state.collectAsStateWithLifecycle().value,
                onOpenProvider = model::openProvider,
                onBack = model::back,
                onCodexConnect = model::codexConnect,
                onCancelLogin = model::cancelLogin,
                onCodexSignOut = model::codexSignOut,
                onSaveSecret = model::saveSecret,
                onRefreshProvider = model::refreshProvider,
                onClearProvider = model::clearProvider,
                onPublish = { model.publish { intent -> bridge.launch(intent) } },
                onExport = {
                    model.export { file ->
                        pendingExport = file
                        export.launch("ai-usage.zip")
                    }
                },
                onAutomatic = model::setAutomatic,
                onMessage = model::setStatus,
            )
        }
        if (savedInstanceState == null) openProviderExtra(intent)
        requestNotificationPermission()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openProviderExtra(intent)
    }

    override fun onResume() {
        super.onResume()
        model.resume()
    }

    private fun openProviderExtra(intent: Intent?) {
        val raw = intent?.getStringExtra("provider")?.trim().orEmpty()
        if (raw.isEmpty()) return
        val id = ProviderId.fromWire(raw)
            ?: ProviderId.entries.firstOrNull { it.name.equals(raw, ignoreCase = true) }
            ?: return
        model.openProvider(id)
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) return
        notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
}
