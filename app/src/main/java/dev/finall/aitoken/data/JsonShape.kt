package dev.finall.aitoken.data

import org.json.JSONArray
import org.json.JSONObject

/** Diagnostics contain field names and types only: never response values or credentials. */
internal fun jsonShape(body: String): String {
    fun shape(value: Any?, depth: Int): Any = when {
        value == null || value === JSONObject.NULL -> "null"
        depth > 6 -> "nested"
        value is JSONObject -> JSONObject().apply {
            value.keys().forEach { key -> put(key, shape(value.opt(key), depth + 1)) }
        }
        value is JSONArray -> JSONArray().apply {
            for (i in 0 until minOf(value.length(), 4)) put(shape(value.opt(i), depth + 1))
        }
        value is Number -> "number"
        value is Boolean -> "boolean"
        else -> "string"
    }
    return shape(JSONObject(body), 0).toString()
}
