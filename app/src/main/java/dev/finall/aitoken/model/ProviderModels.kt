package dev.finall.aitoken.model

import org.json.JSONArray
import org.json.JSONObject

enum class ProviderId(val wire: String) {
    CODEX("codex"),
    KIMI("kimi"),
    DEEPSEEK("deepseek"),
    MIMO("mimo"),
    ;

    companion object {
        fun fromWire(wire: String): ProviderId? = entries.firstOrNull { it.wire == wire }
    }
}

data class ProviderWindow(
    val title: String,
    val usedPercent: Double,
    val windowSeconds: Long,
    val resetAt: Long?,
)

data class ProviderBalance(
    val amount: Double,
    val currency: String,
    val granted: Double?,
    val toppedUp: Double?,
    val isAvailable: Boolean,
)

data class ProviderCredits(
    val used: Double,
    val limit: Double,
    val periodEnd: Long?,
)

data class ProviderBooster(
    val amount: Double,
    val currency: String,
    val monthlyUsed: Double?,
)

data class ProviderSnapshot(
    val id: ProviderId,
    val plan: String?,
    val updatedAt: Long,
    val windows: List<ProviderWindow>,
    val balance: ProviderBalance?,
    val credits: ProviderCredits?,
    val booster: ProviderBooster?,
    val hint: String?,
)

data class ProviderCardEntry(
    val id: ProviderId,
    val snapshot: ProviderSnapshot?,
)

class ProviderAuthException(message: String) : Exception(message)

fun ProviderSnapshot.toCacheJson(): String {
    val windowsJson = JSONArray()
    windows.forEach { windowsJson.put(it.toCacheObject()) }
    return JSONObject()
        .put("id", id.wire)
        .put("plan", plan ?: JSONObject.NULL)
        .put("updatedAt", updatedAt)
        .put("windows", windowsJson)
        .put("balance", balance?.toCacheObject() ?: JSONObject.NULL)
        .put("credits", credits?.toCacheObject() ?: JSONObject.NULL)
        .put("booster", booster?.toCacheObject() ?: JSONObject.NULL)
        .put("hint", hint ?: JSONObject.NULL)
        .toString()
}

fun parseCachedProviderSnapshot(text: String): ProviderSnapshot? {
    val json = try {
        JSONObject(text)
    } catch (_: Exception) {
        return null
    }
    val id = ProviderId.fromWire(json.nullableString("id") ?: return null) ?: return null
    val updatedAt = json.nullableLong("updatedAt") ?: return null
    return ProviderSnapshot(
        id = id,
        plan = json.nullableString("plan"),
        updatedAt = updatedAt,
        windows = json.readWindows(),
        balance = json.readBalance(),
        credits = json.readCredits(),
        booster = json.readBooster(),
        hint = json.nullableString("hint"),
    )
}

private fun ProviderWindow.toCacheObject(): JSONObject =
    JSONObject()
        .put("title", title)
        .put("usedPercent", usedPercent)
        .put("windowSeconds", windowSeconds)
        .put("resetAt", resetAt ?: JSONObject.NULL)

private fun ProviderBalance.toCacheObject(): JSONObject =
    JSONObject()
        .put("amount", amount)
        .put("currency", currency)
        .put("granted", granted ?: JSONObject.NULL)
        .put("toppedUp", toppedUp ?: JSONObject.NULL)
        .put("isAvailable", isAvailable)

private fun ProviderCredits.toCacheObject(): JSONObject =
    JSONObject()
        .put("used", used)
        .put("limit", limit)
        .put("periodEnd", periodEnd ?: JSONObject.NULL)

private fun ProviderBooster.toCacheObject(): JSONObject =
    JSONObject()
        .put("amount", amount)
        .put("currency", currency)
        .put("monthlyUsed", monthlyUsed ?: JSONObject.NULL)

private fun JSONObject.readWindows(): List<ProviderWindow> {
    if (!has("windows") || isNull("windows")) return emptyList()
    val array = optJSONArray("windows") ?: return emptyList()
    val windows = ArrayList<ProviderWindow>(array.length())
    for (index in 0 until array.length()) {
        val item = array.optJSONObject(index) ?: continue
        val title = item.nullableString("title") ?: continue
        val used = item.nullableDouble("usedPercent") ?: continue
        val seconds = item.nullableLong("windowSeconds") ?: continue
        windows.add(ProviderWindow(title, used, seconds, item.nullableLong("resetAt")))
    }
    return windows
}

private fun JSONObject.readBalance(): ProviderBalance? {
    if (!has("balance") || isNull("balance")) return null
    val obj = optJSONObject("balance") ?: return null
    val amount = obj.nullableDouble("amount") ?: return null
    val currency = obj.nullableString("currency") ?: return null
    return ProviderBalance(
        amount = amount,
        currency = currency,
        granted = obj.nullableDouble("granted"),
        toppedUp = obj.nullableDouble("toppedUp"),
        isAvailable = obj.nullableBoolean("isAvailable") ?: false,
    )
}

private fun JSONObject.readCredits(): ProviderCredits? {
    if (!has("credits") || isNull("credits")) return null
    val obj = optJSONObject("credits") ?: return null
    val used = obj.nullableDouble("used") ?: return null
    val limit = obj.nullableDouble("limit") ?: return null
    return ProviderCredits(used, limit, obj.nullableLong("periodEnd"))
}

private fun JSONObject.readBooster(): ProviderBooster? {
    if (!has("booster") || isNull("booster")) return null
    val obj = optJSONObject("booster") ?: return null
    val amount = obj.nullableDouble("amount") ?: return null
    val currency = obj.nullableString("currency") ?: return null
    return ProviderBooster(amount, currency, obj.nullableDouble("monthlyUsed"))
}

private fun JSONObject.nullableString(name: String): String? {
    if (!has(name) || isNull(name)) return null
    return when (val raw = opt(name)) {
        null -> null
        is String -> raw
        is Number, is Boolean -> raw.toString()
        else -> null
    }
}

private fun JSONObject.nullableLong(name: String): Long? {
    if (!has(name) || isNull(name)) return null
    return when (val raw = opt(name)) {
        null -> null
        is Number -> raw.toLong()
        is String -> raw.trim().toLongOrNull() ?: raw.trim().toDoubleOrNull()?.toLong()
        else -> null
    }
}

private fun JSONObject.nullableDouble(name: String): Double? {
    if (!has(name) || isNull(name)) return null
    val value = when (val raw = opt(name)) {
        null -> null
        is Number -> raw.toDouble()
        is String -> raw.trim().toDoubleOrNull()
        else -> null
    } ?: return null
    return value.takeIf { it.isFinite() }
}

private fun JSONObject.nullableBoolean(name: String): Boolean? {
    if (!has(name) || isNull(name)) return null
    return when (val raw = opt(name)) {
        null -> null
        is Boolean -> raw
        is Number -> raw.toInt() != 0
        is String -> when (raw.trim().lowercase()) {
            "true", "1" -> true
            "false", "0" -> false
            else -> null
        }
        else -> null
    }
}
