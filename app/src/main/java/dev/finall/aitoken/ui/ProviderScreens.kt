package dev.finall.aitoken.ui

import android.annotation.SuppressLint
import android.webkit.WebChromeClient
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.net.http.SslError
import android.graphics.Bitmap
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.delay
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebResourceResponse
import android.net.Uri
import dev.finall.aitoken.data.requestMimoLoginUrl
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.finall.aitoken.ProviderUiState
import dev.finall.aitoken.UsageUiState
import dev.finall.aitoken.model.ProviderId
import dev.finall.aitoken.model.ProviderSnapshot
import java.util.concurrent.atomic.AtomicBoolean
import top.yukonga.miuix.kmp.basic.BasicComponent
import top.yukonga.miuix.kmp.basic.Button
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.Scaffold
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.Icon
import top.yukonga.miuix.kmp.basic.IconButton
import top.yukonga.miuix.kmp.basic.SmallTitle
import top.yukonga.miuix.kmp.basic.SmallTopAppBar
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Back
import top.yukonga.miuix.kmp.basic.TextField
import top.yukonga.miuix.kmp.basic.TopAppBar

@Composable
fun ProviderScreen(
    id: ProviderId,
    state: UsageUiState,
    onBack: () -> Unit,
    onCodexConnect: () -> Unit,
    onCancelLogin: () -> Unit,
    onCodexSignOut: () -> Unit,
    onSaveSecret: (ProviderId, String) -> Unit,
    onRefreshProvider: (ProviderId) -> Unit,
    onClearProvider: (ProviderId) -> Unit,
    onMessage: (String) -> Unit,
    onMimoLogin: () -> Unit,
) {
    val provider = state.providers[id] ?: ProviderUiState()
    when (id) {
        ProviderId.CODEX -> CodexPage(
            state = state,
            provider = provider,
            onBack = onBack,
            onConnect = onCodexConnect,
            onCancelLogin = onCancelLogin,
            onRefresh = { onRefreshProvider(ProviderId.CODEX) },
            onSignOut = onCodexSignOut,
            onMessage = onMessage,
        )
        ProviderId.KIMI -> KeyPage(
            id = id,
            title = id.displayName(),
            instructions = "在 kimi.com/code/console 创建 API Key",
            secretLabel = "API Key",
            state = state,
            provider = provider,
            onBack = onBack,
            onSaveSecret = onSaveSecret,
            onRefreshProvider = onRefreshProvider,
            onClearProvider = onClearProvider,
            summary = { KimiSummary(it) },
        )
        ProviderId.DEEPSEEK -> KeyPage(
            id = id,
            title = id.displayName(),
            instructions = "在 platform.deepseek.com 的 API Keys 页创建 Key",
            secretLabel = "API Key",
            state = state,
            provider = provider,
            onBack = onBack,
            onSaveSecret = onSaveSecret,
            onRefreshProvider = onRefreshProvider,
            onClearProvider = onClearProvider,
            summary = { DeepSeekSummary(it) },
        )
        ProviderId.MIMO -> MimoPage(
            state = state,
            provider = provider,
            onBack = onBack,
            onSaveSecret = { onSaveSecret(ProviderId.MIMO, it) },
            onRefresh = { onRefreshProvider(ProviderId.MIMO) },
            onClear = { onClearProvider(ProviderId.MIMO) },
            onOpenLogin = onMimoLogin,
        )
    }
}

@Composable
private fun CodexPage(
    state: UsageUiState,
    provider: ProviderUiState,
    onBack: () -> Unit,
    onConnect: () -> Unit,
    onCancelLogin: () -> Unit,
    onRefresh: () -> Unit,
    onSignOut: () -> Unit,
    onMessage: (String) -> Unit,
) {
    val uriHandler = LocalUriHandler.current
    val clipboard = LocalClipboardManager.current
    DetailScaffold(title = ProviderId.CODEX.displayName(), onBack = onBack) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            provider.snapshot?.let { snapshot ->
                item {
                    Card(Modifier.fillMaxWidth()) { CodexSummary(snapshot) }
                }
            }
            val login = state.login
            if (login != null) {
                item {
                    Card(Modifier.fillMaxWidth()) {
                        BasicComponent(
                            title = "验证码：${login.userCode}",
                            summary = "在 OpenAI 官方网页输入此验证码。不要把验证码发给其他人。",
                        )
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Button(
                                onClick = {
                                    clipboard.setText(AnnotatedString(login.userCode))
                                    try {
                                        uriHandler.openUri(login.verificationUrl)
                                    } catch (_: Exception) {
                                        onMessage("无法打开浏览器，请访问 ${login.verificationUrl}")
                                    }
                                },
                                modifier = Modifier.fillMaxWidth(),
                                colors = ButtonDefaults.buttonColorsPrimary(),
                            ) { Text("复制验证码并打开 OpenAI") }
                            Button(onClick = onCancelLogin, modifier = Modifier.fillMaxWidth()) { Text("取消登录") }
                        }
                    }
                }
            } else if (provider.configured && !provider.authExpired) {
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Button(
                            onClick = onRefresh,
                            enabled = !state.busy,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("刷新") }
                        Button(
                            onClick = onSignOut,
                            enabled = !state.busy,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("退出登录") }
                    }
                }
            } else {
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        if (provider.authExpired) {
                            Text("授权已过期，请重新连接 OpenAI。", modifier = Modifier.padding(horizontal = 8.dp))
                        }
                        Button(
                            onClick = onConnect,
                            enabled = !state.busy,
                            colors = ButtonDefaults.buttonColorsPrimary(),
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("连接 OpenAI · Device Code") }
                        Text(
                            "首次使用可能需要在 ChatGPT → 设置 → 安全中开启设备码登录。",
                            modifier = Modifier.padding(horizontal = 8.dp),
                        )
                        if (provider.configured) {
                            Button(
                                onClick = onSignOut,
                                enabled = !state.busy,
                                modifier = Modifier.fillMaxWidth(),
                            ) { Text("退出登录") }
                        }
                    }
                }
            }
            item { StatusCard(state.status) }
        }
    }
}

@Composable
private fun KeyPage(
    id: ProviderId,
    title: String,
    instructions: String,
    secretLabel: String,
    state: UsageUiState,
    provider: ProviderUiState,
    onBack: () -> Unit,
    onSaveSecret: (ProviderId, String) -> Unit,
    onRefreshProvider: (ProviderId) -> Unit,
    onClearProvider: (ProviderId) -> Unit,
    summary: @Composable (ProviderSnapshot) -> Unit,
) {
    var secret by remember { mutableStateOf("") }
    DetailScaffold(title = title, onBack = onBack) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item {
                Card(Modifier.fillMaxWidth()) {
                    BasicComponent(title = "获取 API Key", summary = instructions)
                }
            }
            item {
                Column {
                    SmallTitle(text = "授权设置")
                    Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    TextField(
                        value = secret,
                        onValueChange = { secret = it },
                        label = secretLabel,
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        enabled = !state.busy,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(
                        onClick = { onSaveSecret(id, secret) },
                        enabled = !state.busy && secret.isNotBlank(),
                        colors = ButtonDefaults.buttonColorsPrimary(),
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("保存并刷新") }
                    }
                    }
                }
            }
            if (provider.configured) {
                item {
                    Card(Modifier.fillMaxWidth()) {
                        val snapshot = provider.snapshot
                        if (snapshot == null) {
                            BasicComponent(title = "用量", summary = "已设置 · 等待刷新")
                        } else {
                            summary(snapshot)
                        }
                    }
                }
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Button(
                            onClick = { onRefreshProvider(id) },
                            enabled = !state.busy,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("刷新") }
                        Button(
                            onClick = { onClearProvider(id) },
                            enabled = !state.busy,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("清除凭据") }
                    }
                }
            }
            item { StatusCard(state.status) }
        }
    }
}

@Composable
private fun MimoPage(
    state: UsageUiState,
    provider: ProviderUiState,
    onBack: () -> Unit,
    onSaveSecret: (String) -> Unit,
    onRefresh: () -> Unit,
    onClear: () -> Unit,
    onOpenLogin: () -> Unit,
) {
    var cookie by remember { mutableStateOf("") }
    DetailScaffold(title = ProviderId.MIMO.displayName(), onBack = onBack) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item {
                Card(Modifier.fillMaxWidth()) {
                    BasicComponent(title = "小米账号", summary = "登录开放平台，读取 Token Plan 用量")
                }
            }
            item {
                Button(
                    onClick = onOpenLogin,
                    enabled = !state.busy,
                    colors = ButtonDefaults.buttonColorsPrimary(),
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("打开小米账号登录") }
            }
            item {
                Column {
                    SmallTitle(text = "手动授权（备用）")
                    Card(Modifier.fillMaxWidth()) {
                    BasicComponent(title = "使用 Cookie", summary = "浏览器登录 platform.xiaomimimo.com 后，从开发者工具复制 Cookie。")
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    TextField(
                        value = cookie,
                        onValueChange = { cookie = it },
                        label = "手动粘贴 Cookie",
                        singleLine = false,
                        maxLines = 4,
                        enabled = !state.busy,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(
                        onClick = { onSaveSecret(cookie) },
                        enabled = !state.busy && cookie.isNotBlank(),
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("保存并刷新") }
                    }
                    }
                }
            }
            if (provider.configured) {
                item {
                    Card(Modifier.fillMaxWidth()) {
                        val snapshot = provider.snapshot
                        if (snapshot == null) {
                            BasicComponent(title = "用量", summary = "已设置 · 等待刷新")
                        } else {
                            MimoSummary(snapshot)
                        }
                    }
                }
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Button(
                            onClick = onRefresh,
                            enabled = !state.busy,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("刷新") }
                        Button(
                            onClick = onClear,
                            enabled = !state.busy,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("清除凭据") }
                    }
                }
            }
            item { StatusCard(state.status) }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun MimoWebLogin(
    onBack: () -> Unit,
    onCookie: (String) -> Unit,
) {
    var loginUrl by remember { mutableStateOf<String?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableStateOf(0) }
    var progress by remember { mutableStateOf(0) }
    val context = LocalContext.current
    val diagnostics = remember { MimoWebDiagnostics(context) }
    LaunchedEffect(loginUrl, retry) {
        if (loginUrl != null) {
            delay(30_000)
            if (progress < 100 && loadError == null) {
                diagnostics.event("timeout", metrics = progress.toString())
                loadError = "登录页加载超时，请检查网络后重试"
            }
        }
    }
    LaunchedEffect(retry) {
        progress = 0
        loadError = null
        loginUrl = null
        try {
            loginUrl = withContext(Dispatchers.IO) { requestMimoLoginUrl() }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            loadError = error.message ?: "无法打开小米账号登录页"
        }
    }
    val callback = remember { CookieCallback(onCookie) }
    callback.onCookie = onCookie
    val consumed = remember { AtomicBoolean(false) }
    Scaffold(
        topBar = {
            SmallTopAppBar(
                title = "小米账号登录",
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(imageVector = MiuixIcons.Back, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        val currentUrl = loginUrl
        val failure = loadError
        if (failure != null || currentUrl == null) {
            Column(Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
                Card(Modifier.fillMaxWidth()) {
                    BasicComponent(title = if (failure == null) "正在打开小米账号登录" else "登录页加载失败",
                        summary = failure ?: "正在获取开放平台授权入口，请稍候")
                }
                if (failure != null) Button(onClick = { retry++ }, modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) { Text("重试") }
            }
            return@Scaffold
        }
        Column(Modifier.fillMaxSize().padding(padding)) {
        if (progress < 100) {
            BasicComponent(title = "正在加载小米账号登录", summary = "$progress%")
        }
        AndroidView(
            modifier = Modifier.fillMaxWidth().weight(1f),
            factory = { context ->
                WebView(context).apply {
                    // Passport uses percentage-height containers; WebView must have a fixed viewport,
                    // not its default wrap-content sizing inside AndroidView.
                    layoutParams = android.view.ViewGroup.LayoutParams(
                        android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                        android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    val cookies = CookieManager.getInstance()
                    cookies.setAcceptCookie(true)
                    cookies.setAcceptThirdPartyCookies(this, true)
                    webChromeClient = object : WebChromeClient() {
                        override fun onProgressChanged(view: WebView?, newProgress: Int) {
                            progress = newProgress
                            diagnostics.event("progress", view?.url, newProgress.toString())
                        }

                        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                            // Do not persist the message: it may include tokens or account data.
                            val category = when {
                                message.message().contains("SyntaxError") -> "syntax"
                                message.message().contains("TypeError") -> "type"
                                message.message().contains("ReferenceError") -> "reference"
                                message.message().contains("chunk", ignoreCase = true) -> "chunk"
                                else -> "other"
                            }
                            diagnostics.event("console-${message.messageLevel().name}-$category")
                            return true
                        }
                    }
                    webViewClient = object : WebViewClient() {
                        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                            diagnostics.event("started", url)
                        }

                        override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler, error: SslError) {
                            diagnostics.event("ssl-error", metrics = error.primaryError.toString())
                            handler.cancel()
                            loadError = "登录页安全连接失败，请检查设备时间和网络"
                        }

                        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail): Boolean {
                            diagnostics.event("renderer-gone", metrics = if (detail.didCrash()) "1" else "0")
                            loadError = "登录页渲染进程已退出，请重试"
                            return true
                        }
                        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean {
                            val uri = request.url
                            diagnostics.event("navigation", uri.toString())
                            // Passport's followup can use HTTP even though the STS callback is HTTPS.
                            if (uri.scheme == "http" && (uri.host == "platform.xiaomimimo.com" || uri.host == "account.xiaomi.com")) {
                                view?.loadUrl(uri.buildUpon().scheme("https").build().toString())
                                return true
                            }
                            return uri.scheme != "https"
                        }

                        override fun onReceivedError(view: WebView?, request: WebResourceRequest, error: WebResourceError) {
                            diagnostics.event(if (request.isForMainFrame) "main-error" else "resource-error", request.url.toString(), error.errorCode.toString())
                            if (request.isForMainFrame) loadError = "网络加载失败（${error.errorCode}），请检查网络后重试"
                        }

                        override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                            diagnostics.event(if (request.isForMainFrame) "main-http" else "resource-http", request.url.toString(), errorResponse.statusCode.toString())
                            if (request.isForMainFrame) loadError = "登录服务响应异常（${errorResponse.statusCode}），请重试"
                        }

                        override fun onPageFinished(view: WebView?, url: String?) {
                            super.onPageFinished(view, url)
                            diagnostics.event("finished", url, "${view?.width ?: 0},${view?.height ?: 0}")
                            view?.evaluateJavascript("""
                                (function(){return [document.querySelectorAll('*').length,
                                document.scripts.length,document.body ? document.body.children.length : 0,
                                document.body ? document.body.getBoundingClientRect().height : 0];})()
                            """.trimIndent()) { result ->
                                val numbers = runCatching { org.json.JSONArray(result) }.getOrNull()
                                if (numbers != null && numbers.length() == 4) {
                                    diagnostics.event("dom", metrics = (0..3).joinToString(",") { numbers.optDouble(it, -1.0).toString() })
                                }
                            }
                            view?.postDelayed({
                                view.evaluateJavascript("""
                                    (function(){return [document.querySelectorAll('*').length,
                                    document.getElementById('root') ? document.getElementById('root').children.length : -1,
                                    document.body ? document.body.getBoundingClientRect().height : -1,
                                    typeof window.region !== 'undefined' ? 1 : 0,
                                    performance.getEntriesByType('resource').length,
                                    document.readyState === 'complete' ? 1 : 0,
                                    getComputedStyle(document.body).display === 'none' ? 1 : 0,
                                    window.innerWidth,window.innerHeight,document.documentElement.clientHeight,
                                    document.getElementById('root') ? document.getElementById('root').getBoundingClientRect().height : -1,
                                    document.body.scrollHeight,
                                    parseFloat(getComputedStyle(document.documentElement).height) || 0,
                                    document.styleSheets.length,
                                    Array.from(document.querySelectorAll('*')).filter(e=>e.getBoundingClientRect().height>0).length,
                                    getComputedStyle(document.documentElement).display === 'none' ? 1 : 0,
                                    getComputedStyle(document.getElementById('root')).display === 'none' ? 1 : 0,
                                    getComputedStyle(document.getElementById('root')).visibility === 'hidden' ? 1 : 0,
                                    parseFloat(getComputedStyle(document.getElementById('root')).opacity)];})()
                                """.trimIndent()) { result ->
                                    val numbers = runCatching { org.json.JSONArray(result) }.getOrNull()
                                    if (numbers != null && numbers.length() == 19) diagnostics.event("dom-delayed", metrics = (0..18).joinToString(",") { numbers.optDouble(it, -1.0).toString() })
                                }
                            }, 2000)
                            capture(view)
                        }

                        override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
                            super.doUpdateVisitedHistory(view, url, isReload)
                            capture(view)
                        }

                        private fun capture(view: WebView?) {
                            if (consumed.get() || Uri.parse(view?.url.orEmpty()).host != "platform.xiaomimimo.com") return
                            val cookie = runCatching {
                                CookieManager.getInstance().getCookie(MIMO_COOKIE_URL)
                            }.getOrNull() ?: return
                            if (!cookie.contains(MIMO_TOKEN_MARK)) return
                            if (!consumed.compareAndSet(false, true)) return
                            CookieManager.getInstance().flush()
                            val deliver = callback.onCookie
                            if (view == null) deliver(cookie) else view.post { deliver(cookie) }
                        }
                    }
                    loadUrl(currentUrl)
                }
            },
            onRelease = { it.stopLoading(); it.destroy() },
        )
        }
    }
}

@Composable
private fun CodexSummary(snapshot: ProviderSnapshot) {
    snapshot.plan?.takeIf { it.isNotBlank() }?.let {
        BasicComponent(title = "套餐", summary = it)
    }
    WindowRows(snapshot)
    snapshot.hint?.takeIf { it.isNotBlank() }?.let {
        BasicComponent(title = "说明", summary = it)
    }
    BasicComponent(title = "更新时间", summary = formatEpoch(snapshot.updatedAt, "yyyy-MM-dd HH:mm"))
}

@Composable
private fun KimiSummary(snapshot: ProviderSnapshot) {
    snapshot.plan?.takeIf { it.isNotBlank() }?.let {
        BasicComponent(title = "套餐", summary = it)
    }
    WindowRows(snapshot)
    snapshot.booster?.let { booster ->
        val monthly = booster.monthlyUsed?.let { " · 本月已用 ${formatMoney(it, booster.currency)}" }.orEmpty()
        BasicComponent(title = "加油包余额", summary = formatMoney(booster.amount, booster.currency) + monthly)
    }
}

@Composable
private fun DeepSeekSummary(snapshot: ProviderSnapshot) {
    val balance = snapshot.balance
    if (balance == null) {
        BasicComponent(title = "余额", summary = "暂无余额数据")
        return
    }
    BasicComponent(title = "总额", summary = formatMoney(balance.amount, balance.currency))
    BasicComponent(
        title = "充值",
        summary = balance.toppedUp?.let { formatMoney(it, balance.currency) } ?: "暂无",
    )
    BasicComponent(
        title = "赠金",
        summary = balance.granted?.let { formatMoney(it, balance.currency) } ?: "暂无",
    )
    BasicComponent(title = "是否可用", summary = if (balance.isAvailable) "可用" else "不可用")
}

@Composable
private fun MimoSummary(snapshot: ProviderSnapshot) {
    val percent = snapshot.windows.firstOrNull()?.usedPercent
    BasicComponent(title = snapshot.windows.firstOrNull()?.title ?: "套餐额度", summary = percent?.let { formatPercent(it) } ?: "暂无百分比")
    val credits = snapshot.credits
    BasicComponent(
        title = "Credits",
        summary = if (credits == null) "暂无" else "${formatCredits(credits.used)}/${formatCredits(credits.limit)}",
    )
    val periodEnd = credits?.periodEnd ?: snapshot.windows.firstOrNull()?.resetAt
    BasicComponent(
        title = "套餐截止",
        summary = periodEnd?.let { formatEpoch(it, "yyyy-MM-dd HH:mm") } ?: "未提供",
    )
    snapshot.plan?.takeIf { it.isNotBlank() }?.let {
        BasicComponent(title = "套餐", summary = it)
    }
}

@Composable
private fun WindowRows(snapshot: ProviderSnapshot) {
    if (snapshot.windows.isEmpty()) {
        BasicComponent(title = "用量窗口", summary = "暂无窗口数据")
        return
    }
    snapshot.windows.forEach { window ->
        BasicComponent(
            title = window.title,
            summary = "${formatPercent(window.usedPercent)} · ${formatReset(window.resetAt)}",
        )
    }
}

@Composable
private fun StatusCard(status: String) {
    Card(Modifier.fillMaxWidth()) {
        BasicComponent(title = "最近状态", summary = status)
    }
}

@Composable
private fun DetailScaffold(
    title: String,
    onBack: () -> Unit,
    content: @Composable (PaddingValues) -> Unit,
) {
    Scaffold(
        topBar = {
            SmallTopAppBar(
                title = title,
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(imageVector = MiuixIcons.Back, contentDescription = "返回")
                    }
                },
            )
        },
        content = content,
    )
}

private class CookieCallback(var onCookie: (String) -> Unit)

private const val MIMO_LOGIN_URL = "https://platform.xiaomimimo.com/console/plan-manage"
private const val MIMO_COOKIE_URL = "https://platform.xiaomimimo.com"
private const val MIMO_TOKEN_MARK = "api-platform_serviceToken="
