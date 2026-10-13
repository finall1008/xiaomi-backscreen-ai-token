package dev.finall.aitoken.ui

import dev.finall.aitoken.ProviderUiState
import dev.finall.aitoken.model.ProviderId
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs

fun ProviderId.displayName(): String = when (this) {
    ProviderId.CODEX -> "Codex"
    ProviderId.KIMI -> "Kimi Code"
    ProviderId.DEEPSEEK -> "DeepSeek"
    ProviderId.MIMO -> "小米 MiMo"
}

fun ProviderUiState.homeSummary(): String = when {
    authExpired -> "授权已过期，点我重新设置"
    !configured -> "未设置"
    snapshot != null -> "已设置 · 更新于 ${formatEpoch(snapshot.updatedAt, "HH:mm")}"
    else -> "已设置 · 等待刷新"
}

fun formatEpoch(seconds: Long, pattern: String): String =
    DateTimeFormatter.ofPattern(pattern).withZone(ZoneId.systemDefault()).format(Instant.ofEpochSecond(seconds))

fun formatPercent(value: Double): String = "${trimOneDecimal(value)}%"

fun formatReset(seconds: Long?): String =
    if (seconds == null) "未提供重置时间" else "重置于 ${formatEpoch(seconds, "yyyy-MM-dd HH:mm")}"

fun formatMoney(amount: Double, currency: String): String {
    val number = String.format(Locale.US, "%.2f", amount)
    return if (currency.isBlank()) number else "$number $currency"
}

/** Large token counts render as 23.6B / 110B. */
fun formatCredits(value: Double): String {
    if (!value.isFinite()) return "0"
    val negative = value < 0
    val magnitude = abs(value)
    val (scaled, suffix) = when {
        magnitude >= 1_000_000_000.0 -> magnitude / 1_000_000_000.0 to "B"
        magnitude >= 1_000_000.0 -> magnitude / 1_000_000.0 to "M"
        magnitude >= 1_000.0 -> magnitude / 1_000.0 to "K"
        else -> magnitude to ""
    }
    val text = trimOneDecimal(scaled) + suffix
    return if (negative) "-$text" else text
}

private fun trimOneDecimal(value: Double): String {
    val text = String.format(Locale.US, "%.1f", value)
    return if (text.endsWith(".0")) text.dropLast(2) else text
}
