package dev.finall.aitoken.ui

import android.annotation.SuppressLint
import android.graphics.Color
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import java.io.File

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun CardPreview(url: String) {
    AndroidView(
        modifier = Modifier.fillMaxWidth().aspectRatio(912f / 596f),
        factory = { context ->
            WebView(context).apply {
                setBackgroundColor(Color.BLACK)
                settings.javaScriptEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                val assets = WebViewAssetLoader.Builder()
                    .addPathHandler(
                        "/cards/",
                        WebViewAssetLoader.InternalStoragePathHandler(context, File(context.filesDir, "cards")),
                    )
                    .build()
                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest): WebResourceResponse? =
                        assets.shouldInterceptRequest(request.url)
                            ?: WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), null)

                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean =
                        request.url.host != "appassets.androidplatform.net"
                }
                loadUrl(url)
            }
        },
        update = { if (it.url != url) it.loadUrl(url) },
        onRelease = { it.destroy() },
    )
}
