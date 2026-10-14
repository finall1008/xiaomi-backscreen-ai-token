package dev.finall.aitoken.data

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

internal data class HttpRequest(
    val url: String,
    val method: String,
    val headers: Map<String, String> = emptyMap(),
    val body: String? = null,
    val followRedirects: Boolean = false,
) {
    override fun toString(): String = "HttpRequest(method=$method, url=$url)"
}

internal data class HttpResponse(
    val status: Int,
    val body: String,
    val headers: Map<String, List<String>> = emptyMap(),
)

internal fun interface CodexTransport {
    fun execute(request: HttpRequest): HttpResponse
}

internal class HttpUrlConnectionTransport : CodexTransport {
    override fun execute(request: HttpRequest): HttpResponse {
        val connection = URL(request.url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = request.method
            connection.connectTimeout = 20_000
            connection.readTimeout = 30_000
            connection.instanceFollowRedirects = request.followRedirects
            connection.setRequestProperty("Accept", "application/json")
            request.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            if (request.body != null) {
                connection.doOutput = true
                connection.outputStream.use { it.write(request.body.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            return HttpResponse(status, readLimited(stream), connection.headerFields.filterKeys { it != null })
        } catch (error: IOException) {
            throw IOException("网络请求失败")
        } finally {
            connection.disconnect()
        }
    }
}

private fun readLimited(stream: InputStream?): String {
    if (stream == null) return ""
    stream.use { input ->
        val buffer = ByteArrayOutputStream()
        val chunk = ByteArray(4096)
        var total = 0
        while (total < MAX_BODY_BYTES) {
            val count = input.read(chunk, 0, minOf(chunk.size, MAX_BODY_BYTES - total))
            if (count < 0) break
            buffer.write(chunk, 0, count)
            total += count
        }
        return buffer.toString(Charsets.UTF_8)
    }
}

private const val MAX_BODY_BYTES = 1_000_000
