package dev.finall.aitoken.data

import org.json.JSONObject
import org.json.JSONArray

/** Allowlisted quota-only derived diagnostics; no account/wallet/auth values. */
internal fun kimiQuotaSummary(body: String): String {
    val json = JSONObject(body)
    fun summary(value: JSONObject?): JSONObject = JSONObject().apply {
        if (value == null) return@apply
        val limit = value.optString("limit").toDoubleOrNull()
        val used = value.optString("used").toDoubleOrNull()
        if (limit != null && used != null && limit > 0) put("usedPercent", used / limit * 100.0)
        value.optString("resetTime").takeIf { it.isNotBlank() }?.let { put("resetTime", it) }
    }
    return JSONObject().apply {
        put("usage", summary(json.optJSONObject("usage")))
        put("limits", JSONArray().apply {
            val limits = json.optJSONArray("limits") ?: return@apply
            for (i in 0 until limits.length()) {
                val item = limits.optJSONObject(i) ?: continue
                put(JSONObject().apply {
                    val window = item.optJSONObject("window")
                    put("duration", window?.optDouble("duration"))
                    val unit = window?.optString("timeUnit")
                    if (unit != null && unit.matches(Regex("[A-Z_a-z0-9]{1,32}"))) put("timeUnit", unit)
                    put("detail", summary(item.optJSONObject("detail")))
                })
            }
        })
    }.toString()
}
