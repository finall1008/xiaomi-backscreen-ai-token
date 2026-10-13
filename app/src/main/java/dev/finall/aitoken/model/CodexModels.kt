package dev.finall.aitoken.model

/**
 * Device-code login shown to the user.
 * [deviceAuthId], [interval] and [start] stay inside the app module for polling.
 * [start] is the Unix epoch millis when the code was issued; the code expires 15 minutes later.
 */
data class DeviceLogin(
    val verificationUrl: String,
    val userCode: String,
    internal val deviceAuthId: String,
    internal val interval: Long,
    internal val start: Long,
) {
    override fun toString(): String = "DeviceLogin(verificationUrl=$verificationUrl)"
}

/** One Codex rate-limit window. [resetAt] is Unix seconds, absent when the API omits it. */
data class UsageWindow(
    val usedPercent: Double,
    val windowSeconds: Long,
    val resetAt: Long?,
)

/**
 * Cached Codex usage.
 * [primary] is the short window (5 hour when the API reports one).
 * [secondary] is the long window (weekly). Either side is null when the API does not return it.
 * [updatedAt] is Unix seconds of the last successful read.
 */
data class UsageSnapshot(
    val planType: String,
    val updatedAt: Long,
    val primary: UsageWindow?,
    val secondary: UsageWindow?,
)
