package dev.finall.aitoken.data

import dev.finall.aitoken.model.UsageWindow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64

class UsageParsingTest {
    @Test fun plusResponseKeepsBothWindowsByDuration() {
        val snapshot = parseUsagePayload(
            """
            {"plan_type":"plus","rate_limit":{
              "primary_window":{"used_percent":23.5,"limit_window_seconds":18000,"reset_at":1800000100},
              "secondary_window":{"used_percent":4,"limit_window_seconds":604800,"reset_at":1800500000}
            }}
            """.trim(),
            updatedAt = 1_800_000_100,
        )
        assertEquals("plus", snapshot.planType)
        assertEquals(1_800_000_100L, snapshot.updatedAt)
        assertEquals(UsageWindow(23.5, 18_000, 1_800_000_100), snapshot.primary)
        assertEquals(UsageWindow(4.0, 604_800, 1_800_500_000), snapshot.secondary)
    }

    @Test fun proWithoutFiveHourWindowDoesNotInventZero() {
        val snapshot = parseUsagePayload(
            """
            {"plan_type":"pro","rate_limit":{
              "primary_window":null,
              "secondary_window":{"used_percent":8.25,"limit_window_seconds":604800,"reset_after_seconds":3600}
            }}
            """.trim(),
            updatedAt = 1_000,
        )
        assertEquals("pro", snapshot.planType)
        assertNull(snapshot.primary)
        assertEquals(UsageWindow(8.25, 604_800, 4_600), snapshot.secondary)
    }

    @Test fun proKeepsFiveHourWindowWhenApiReturnsIt() {
        val snapshot = parseUsagePayload(
            """
            {"plan_type":"pro","rate_limit":{
              "primary_window":{"used_percent":1,"limit_window_seconds":18000,"reset_at":50},
              "secondary_window":{"used_percent":2,"limit_window_seconds":604800,"reset_at":90}
            }}
            """.trim(),
            updatedAt = 10,
        )
        assertEquals(UsageWindow(1.0, 18_000, 50), snapshot.primary)
        assertEquals(UsageWindow(2.0, 604_800, 90), snapshot.secondary)
    }

    @Test fun classifiesSwappedWindowsByDuration() {
        val snapshot = parseUsagePayload(
            """
            {"plan_type":"plus","rate_limit":{
              "primary_window":{"used_percent":9,"limit_window_seconds":604800,"reset_at":90},
              "secondary_window":{"used_percent":0,"limit_window_seconds":18000,"reset_at":20}
            }}
            """.trim(),
            updatedAt = 10,
        )
        assertEquals(UsageWindow(0.0, 18_000, 20), snapshot.primary)
        assertEquals(UsageWindow(9.0, 604_800, 90), snapshot.secondary)
    }

    @Test fun missingPercentIsNotZero() {
        val snapshot = parseUsagePayload(
            """
            {"plan_type":"plus","rate_limit":{
              "primary_window":{"limit_window_seconds":18000,"reset_at":20},
              "secondary_window":{"used_percent":null,"limit_window_seconds":604800}
            }}
            """.trim(),
            updatedAt = 10,
        )
        assertNull(snapshot.primary)
        assertNull(snapshot.secondary)
    }

    @Test fun missingWindowLengthIsNotZeroSeconds() {
        val snapshot = parseUsagePayload(
            """
            {"plan_type":"plus","rate_limit":{
              "primary_window":{"used_percent":10,"reset_at":20}
            }}
            """.trim(),
            updatedAt = 10,
        )
        assertNull(snapshot.primary)
        assertNull(snapshot.secondary)
        assertEquals("plus", snapshot.planType)
    }

    @Test fun windowMinutesConvertAndCacheRoundTrips() {
        val snapshot = parseUsagePayload(
            """
            {"plan_type":"plus","rate_limit":{
              "primary_window":{"used_percent":3,"window_minutes":300,"resets_at":77}
            }}
            """.trim(),
            updatedAt = 10,
        )
        assertEquals(UsageWindow(3.0, 18_000, 77), snapshot.primary)
        val restored = parseCachedUsage(snapshot.toCacheJson())
        assertEquals(snapshot, restored)
    }

    @Test fun accountIdComesFromAuthClaim() {
        assertEquals("acc_123", chatgptAccountId(jwt("""{"https://api.openai.com/auth":{"chatgpt_account_id":"acc_123"}}""")))
        assertNull(chatgptAccountId("not-a-jwt"))
    }

    private fun jwt(payload: String): String {
        val encoder = Base64.getUrlEncoder().withoutPadding()
        val header = encoder.encodeToString("""{"alg":"none"}""".toByteArray())
        val body = encoder.encodeToString(payload.toByteArray())
        return "$header.$body.sig"
    }
}
