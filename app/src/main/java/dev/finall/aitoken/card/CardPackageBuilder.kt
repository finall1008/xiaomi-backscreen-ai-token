package dev.finall.aitoken.card

import android.content.Context
import dev.finall.aitoken.model.UsageSnapshot
import dev.finall.aitoken.model.UsageWindow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class CardPackageBuilder(private val context: Context) {
    private val root get() = File(context.filesDir, "cards")

    suspend fun preview(snapshot: UsageSnapshot): String = withContext(Dispatchers.IO) {
        synchronized(buildLock) {
            val dir = create(snapshot, preview = true)
            root.listFiles().orEmpty()
                .filter { it.isDirectory && it.name.startsWith("preview-") && it.name != dir.name }
                .sortedByDescending { it.lastModified() }
                .drop(1)
                .forEach { it.deleteRecursively() }
            "https://appassets.androidplatform.net/cards/${dir.name}/index.html"
        }
    }

    suspend fun export(snapshot: UsageSnapshot, background: Boolean = false): File = withContext(Dispatchers.IO) {
        synchronized(buildLock) {
            val dir = create(snapshot, preview = false)
            // The worker must not overwrite a ZIP the foreground bridge is still reading.
            val filename = if (background) "codex-usage-background.zip" else "codex-usage.zip"
            val published = File(context.cacheDir, "published")
            check(published.isDirectory || published.mkdirs()) { "无法创建卡片发布目录" }
            val target = File(published, filename)
            val partial = File(context.cacheDir, ".$filename.partial")
            try {
                ZipOutputStream(partial.outputStream().buffered()).use { zip -> writeZip(dir, dir, zip) }
                moveReplace(partial, target)
            } catch (error: Exception) {
                partial.delete()
                throw error
            }
            target
        }
    }

    private fun create(snapshot: UsageSnapshot, preview: Boolean): File {
        check(root.isDirectory || root.mkdirs()) { "无法创建卡片目录" }
        val dir = if (preview) File(root, "preview-${System.nanoTime()}") else File(root, "package")
        if (!preview && dir.exists()) dir.deleteRecursively()
        check(dir.mkdirs()) { "无法创建卡片包目录" }
        copyAssets("card", dir)
        File(dir, "index.html").writeText(render(snapshot, preview))
        check(File(dir, "main.js").isFile) { "缺少 main.js" }
        check(File(dir, "assets/openai.png").isFile) { "缺少静态 logo assets/openai.png" }
        return dir
    }

    /**
     * Null windows stay JSON null. A missing window is not usage of 0%.
     * The card script shows missing values as unavailable, keeping the original layout.
     */
    private fun render(snapshot: UsageSnapshot, preview: Boolean): String {
        val template = context.assets.open("card/index.html").bufferedReader(Charsets.UTF_8).use { it.readText() }
        check(USAGE_TOKEN in template && LENS_START in template && LENS_END in template) { "卡片模板缺少用量或镜头占位" }
        val data = usageJson(snapshot)
        val withData = template.replace(USAGE_TOKEN, data)
        val html = if (preview) {
            withData.replace(LENS_START, "").replace(LENS_END, "")
        } else {
            lensBlock.replace(withData, "")
        }
        check(USAGE_TOKEN !in html && "PREVIEW_LENS" !in html) { "卡片模板占位未替换" }
        if (!preview) check("class=\"lens" !in html) { "导出的卡片不应包含镜头示意" }
        return html
    }

    private fun usageJson(snapshot: UsageSnapshot): String {
        val config = JSONObject()
            .put("provider", "codex")
            .put("planType", snapshot.planType)
            .put("updatedAt", snapshot.updatedAt)
            .put("logoAsset", "assets/openai.png")
            .put("primary", windowJson(snapshot.primary))
            .put("secondary", windowJson(snapshot.secondary))
        return config.toString()
            .replace("<", "\\u003c")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
    }

    private fun windowJson(window: UsageWindow?): Any {
        window ?: return JSONObject.NULL
        return JSONObject()
            .put("usedPercent", window.usedPercent)
            .put("windowSeconds", window.windowSeconds)
            .put("resetAt", window.resetAt ?: JSONObject.NULL)
    }

    private fun writeZip(dir: File, base: File, zip: ZipOutputStream) {
        dir.listFiles().orEmpty().sortedBy { it.name }.forEach { file ->
            if (file.isDirectory) {
                writeZip(file, base, zip)
            } else {
                zip.putNextEntry(ZipEntry(file.relativeTo(base).invariantSeparatorsPath))
                file.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
        }
    }

    private fun copyAssets(path: String, dir: File) {
        context.assets.list(path).orEmpty().forEach { name ->
            val child = "$path/$name"
            val target = File(dir, name)
            if (context.assets.list(child).orEmpty().isNotEmpty()) {
                check(target.isDirectory || target.mkdirs()) { "无法创建资源目录" }
                copyAssets(child, target)
            } else {
                check(target.parentFile?.let { it.isDirectory || it.mkdirs() } == true) { "无法创建资源目录" }
                context.assets.open(child).use { input -> target.outputStream().use { input.copyTo(it) } }
            }
        }
    }

    private fun moveReplace(partial: File, target: File) {
        try {
            Files.move(
                partial.toPath(),
                target.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE,
            )
        } catch (_: AtomicMoveNotSupportedException) {
            partial.copyTo(target, overwrite = true)
            partial.delete()
        }
    }

    companion object {
        private val buildLock = Any()
        private const val USAGE_TOKEN = "/*USAGE_DATA*/"
        private const val LENS_START = "<!--PREVIEW_LENS_START-->"
        private const val LENS_END = "<!--PREVIEW_LENS_END-->"
        private val lensBlock = Regex("(?s)<!--PREVIEW_LENS_START-->.*?<!--PREVIEW_LENS_END-->\\n?")
    }
}
