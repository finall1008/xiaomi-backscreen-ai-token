package dev.finall.aitoken.card

import android.content.Context
import dev.finall.aitoken.model.ProviderBalance
import dev.finall.aitoken.model.ProviderBooster
import dev.finall.aitoken.model.ProviderCardEntry
import dev.finall.aitoken.model.ProviderCredits
import dev.finall.aitoken.model.ProviderId
import dev.finall.aitoken.model.ProviderWindow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class CardPackageBuilder(private val context: Context) {
    private val root get() = File(context.filesDir, "cards")

    suspend fun preview(entries: List<ProviderCardEntry>): String = withContext(Dispatchers.IO) {
        synchronized(buildLock) {
            val dir = create(entries, preview = true)
            root.listFiles().orEmpty()
                .filter { it.isDirectory && it.name.startsWith("preview-") && it.name != dir.name }
                .sortedByDescending { it.lastModified() }
                .drop(1)
                .forEach { it.deleteRecursively() }
            "https://appassets.androidplatform.net/cards/${dir.name}/index.html"
        }
    }

    suspend fun export(entries: List<ProviderCardEntry>, background: Boolean = false): File = withContext(Dispatchers.IO) {
        synchronized(buildLock) {
            val dir = create(entries, preview = false)
            // The worker must not overwrite a ZIP the foreground bridge is still reading.
            val filename = if (background) "ai-usage-background.zip" else "ai-usage.zip"
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

    private fun create(entries: List<ProviderCardEntry>, preview: Boolean): File {
        check(root.isDirectory || root.mkdirs()) { "无法创建卡片目录" }
        val dir = if (preview) File(root, "preview-${System.nanoTime()}") else File(root, "package")
        if (!preview && dir.exists()) dir.deleteRecursively()
        check(dir.mkdirs()) { "无法创建卡片包目录" }
        copyAssets("card", dir)
        File(dir, "index.html").writeText(render(entries, preview))
        check(File(dir, "main.js").isFile) { "缺少 main.js" }
        LOGO_ASSETS.forEach { asset ->
            check(File(dir, asset).isFile) { "缺少静态 logo $asset" }
        }
        return dir
    }

    /**
     * Null fields are omitted. A provider with no snapshot still appears, with an empty windows array.
     */
    private fun render(entries: List<ProviderCardEntry>, preview: Boolean): String {
        val template = context.assets.open("card/index.html").bufferedReader(Charsets.UTF_8).use { it.readText() }
        check(USAGE_TOKEN in template && LENS_START in template && LENS_END in template) { "卡片模板缺少用量或镜头占位" }
        val data = usageJson(entries)
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

    private fun usageJson(entries: List<ProviderCardEntry>): String {
        val updatedAt = entries.mapNotNull { it.snapshot?.updatedAt }.maxOrNull()
            ?: (System.currentTimeMillis() / 1000)
        val providers = JSONArray()
        entries.sortedBy { it.id.ordinal }.forEach { providers.put(providerJson(it)) }
        val config = JSONObject()
            .put("updatedAt", updatedAt)
            .put("providers", providers)
        return config.toString()
            .replace("<", "\\u003c")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
    }

    private fun providerJson(entry: ProviderCardEntry): JSONObject {
        val snapshot = entry.snapshot
        val obj = JSONObject()
            .put("id", entry.id.wire)
            .put("name", entry.id.cardName)
        if (snapshot != null) putOpt(obj, "plan", snapshot.plan)
        obj.put("logoAsset", entry.id.logoAsset)
            .put("windows", windowsJson(snapshot?.windows.orEmpty()))
        if (snapshot == null) return obj
        snapshot.balance?.let { obj.put("balance", balanceJson(it)) }
        snapshot.credits?.let { obj.put("credits", creditsJson(it)) }
        snapshot.booster?.let { obj.put("booster", boosterJson(it)) }
        putOpt(obj, "hint", snapshot.hint)
        obj.put("updatedAt", snapshot.updatedAt)
        return obj
    }

    private fun windowsJson(windows: List<ProviderWindow>): JSONArray {
        val array = JSONArray()
        windows.forEach { window ->
            val obj = JSONObject()
                .put("title", window.title)
                .put("usedPercent", window.usedPercent)
                .put("windowSeconds", window.windowSeconds)
            putOpt(obj, "resetAt", window.resetAt)
            array.put(obj)
        }
        return array
    }

    private fun balanceJson(balance: ProviderBalance): JSONObject {
        val obj = JSONObject()
            .put("amount", balance.amount)
            .put("currency", balance.currency)
        putOpt(obj, "granted", balance.granted)
        putOpt(obj, "toppedUp", balance.toppedUp)
        obj.put("isAvailable", balance.isAvailable)
        return obj
    }

    private fun creditsJson(credits: ProviderCredits): JSONObject {
        val obj = JSONObject()
            .put("used", credits.used)
            .put("limit", credits.limit)
        putOpt(obj, "periodEnd", credits.periodEnd)
        return obj
    }

    private fun boosterJson(booster: ProviderBooster): JSONObject {
        val obj = JSONObject()
            .put("amount", booster.amount)
            .put("currency", booster.currency)
        putOpt(obj, "monthlyUsed", booster.monthlyUsed)
        return obj
    }

    private fun putOpt(obj: JSONObject, key: String, value: Any?) {
        if (value != null) obj.put(key, value)
    }

    private val ProviderId.cardName: String
        get() = when (this) {
            ProviderId.CODEX -> "Codex"
            ProviderId.KIMI -> "Kimi Code"
            ProviderId.DEEPSEEK -> "DeepSeek"
            ProviderId.MIMO -> "小米 MiMo"
        }

    private val ProviderId.logoAsset: String
        get() = when (this) {
            ProviderId.CODEX -> "assets/openai.png"
            ProviderId.KIMI -> "assets/kimi.png"
            ProviderId.DEEPSEEK -> "assets/deepseek.png"
            ProviderId.MIMO -> "assets/mimo.png"
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
        private val LOGO_ASSETS = listOf(
            "assets/openai.png",
            "assets/kimi.png",
            "assets/deepseek.png",
            "assets/mimo.png",
        )
        private const val USAGE_TOKEN = "/*USAGE_DATA*/"
        private const val LENS_START = "<!--PREVIEW_LENS_START-->"
        private const val LENS_END = "<!--PREVIEW_LENS_END-->"
        private val lensBlock = Regex("(?s)<!--PREVIEW_LENS_START-->.*?<!--PREVIEW_LENS_END-->\\n?")
    }
}
