package dev.finall.aitoken.ui

import android.annotation.SuppressLint
import android.graphics.Color
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import dev.finall.aitoken.UsageUiState
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import top.yukonga.miuix.kmp.basic.BasicComponent
import top.yukonga.miuix.kmp.basic.Button
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.Scaffold
import top.yukonga.miuix.kmp.basic.Switch
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextField
import top.yukonga.miuix.kmp.basic.TopAppBar
import top.yukonga.miuix.kmp.theme.ColorSchemeMode
import top.yukonga.miuix.kmp.theme.MiuixTheme
import top.yukonga.miuix.kmp.theme.ThemeController

@Composable
fun UsageScreen(
    state: UsageUiState,
    onConnect: () -> Unit,
    onCancelLogin: () -> Unit,
    onRefresh: () -> Unit,
    onPublish: () -> Unit,
    onExport: () -> Unit,
    onAutomatic: (Boolean, Long) -> Unit,
    onSignOut: () -> Unit,
    onMessage: (String) -> Unit,
) {
    val controller = remember { ThemeController(colorSchemeMode = ColorSchemeMode.System) }
    val uriHandler = LocalUriHandler.current
    val clipboard = LocalClipboardManager.current
    var interval by remember(state.intervalMinutes) { mutableStateOf(state.intervalMinutes.toString()) }
    MiuixTheme(controller = controller) {
        Scaffold(topBar = { TopAppBar(title = "AI 用量背屏") }) { padding ->
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                item {
                    Card(Modifier.fillMaxWidth()) {
                        BasicComponent(title = "OpenAI Codex", summary = if (state.signedIn) "已连接 · ${state.usage?.planType?.uppercase() ?: "等待用量"}" else "使用 OpenAI 官方设备码登录，不需要电脑")
                        BasicComponent(title = "最近状态", summary = state.status)
                    }
                }
                state.previewUrl?.let { url ->
                    item { Card(Modifier.fillMaxWidth(), insideMargin = PaddingValues(0.dp)) { CardPreview(url) } }
                }
                state.login?.let { login ->
                    item {
                        Card(Modifier.fillMaxWidth()) {
                            BasicComponent(title = "验证码：${login.userCode}", summary = "在 OpenAI 官方网页输入此验证码。不要把验证码发给其他人。")
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Button(onClick = {
                                    clipboard.setText(AnnotatedString(login.userCode))
                                    try { uriHandler.openUri(login.verificationUrl) }
                                    catch (_: Exception) { onMessage("无法打开浏览器，请访问 ${login.verificationUrl}") }
                                }, modifier = Modifier.fillMaxWidth()) { Text("复制验证码并打开 OpenAI") }
                                Button(onClick = onCancelLogin, modifier = Modifier.fillMaxWidth()) { Text("取消登录") }
                            }
                        }
                    }
                }
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        if (!state.signedIn) {
                            Button(onClick = onConnect, enabled = !state.busy, colors = ButtonDefaults.buttonColorsPrimary(), modifier = Modifier.fillMaxWidth()) { Text("连接 OpenAI · Device Code") }
                            Text("首次使用可能需要在 ChatGPT → 设置 → 安全中开启设备码登录。", modifier = Modifier.padding(horizontal = 8.dp))
                        } else {
                            Button(onClick = onRefresh, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("刷新套餐用量") }
                        }
                        Button(onClick = onPublish, enabled = !state.busy && state.usage != null, colors = ButtonDefaults.buttonColorsPrimary(), modifier = Modifier.fillMaxWidth()) { Text("发送到背屏") }
                        Button(onClick = onExport, enabled = !state.busy && state.usage != null, modifier = Modifier.fillMaxWidth()) { Text("导出卡片 ZIP") }
                    }
                }
                state.usage?.let { usage ->
                    item {
                        Card(Modifier.fillMaxWidth()) {
                            val updated = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochSecond(usage.updatedAt))
                            BasicComponent(title = "数据更新时间", summary = updated)
                            BasicComponent(title = "首次发送", summary = "在背屏卡片桥中选择载体并绑定，再到系统背屏设置重新应用一次。之后自动更新无需 Shizuku。")
                        }
                    }
                }
                item {
                    Card(Modifier.fillMaxWidth()) {
                        BasicComponent(title = "后台自动刷新", summary = "登录后刷新用量；绑定背屏后同时保存最新卡片。系统可能延迟执行。", endActions = {
                            Switch(checked = state.autoRefresh, enabled = state.signedIn && !state.busy,
                                onCheckedChange = { enabled ->
                                    val minutes = interval.toLongOrNull()
                                    if (minutes == null || minutes < 15) onMessage("刷新间隔请输入至少 15 的整数")
                                    else onAutomatic(enabled, minutes)
                                })
                        })
                        TextField(value = interval, onValueChange = { interval = it }, label = "刷新间隔（分钟，至少 15）", singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp), enabled = !state.busy)
                        Button(onClick = {
                            val minutes = interval.toLongOrNull()
                            if (minutes == null || minutes < 15) onMessage("刷新间隔请输入至少 15 的整数")
                            else onAutomatic(state.autoRefresh, minutes)
                        }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().padding(16.dp)) { Text("保存刷新设置") }
                    }
                }
                if (state.signedIn) item {
                    Button(onClick = onSignOut, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("退出登录并清除本机凭据") }
                }
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun CardPreview(url: String) {
    AndroidView(
        modifier = Modifier.fillMaxWidth().aspectRatio(912f / 596f),
        factory = { context ->
            WebView(context).apply {
                setBackgroundColor(Color.BLACK)
                settings.javaScriptEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                val assets = WebViewAssetLoader.Builder().addPathHandler("/cards/", WebViewAssetLoader.InternalStoragePathHandler(context, File(context.filesDir, "cards"))).build()
                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest): WebResourceResponse? =
                        assets.shouldInterceptRequest(request.url) ?: WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), null)
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean = request.url.host != "appassets.androidplatform.net"
                }
                loadUrl(url)
            }
        },
        update = { if (it.url != url) it.loadUrl(url) },
        onRelease = { it.destroy() },
    )
}
