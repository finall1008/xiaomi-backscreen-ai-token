package dev.finall.aitoken.data

import dev.finall.aitoken.model.ProviderAuthException
import dev.finall.aitoken.model.ProviderBalance
import dev.finall.aitoken.model.ProviderBooster
import dev.finall.aitoken.model.ProviderCredits
import dev.finall.aitoken.model.ProviderId
import dev.finall.aitoken.model.ProviderSnapshot
import dev.finall.aitoken.model.ProviderWindow
import dev.finall.aitoken.model.UsageSnapshot
import dev.finall.aitoken.model.UsageWindow
import dev.finall.aitoken.model.parseCachedProviderSnapshot
import dev.finall.aitoken.model.toCacheJson
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.time.OffsetDateTime

class ProviderParsingTest {
    @Test fun kimiFullPayloadMapsThreeWindowsAndBooster() {
        val transport = ScriptedTransport { request ->
            when (request.url) {
                KIMI_USAGES -> {
                    assertEquals("GET", request.method)
                    assertEquals("Bearer sk-kimi", request.headers["Authorization"])
                    HttpResponse(200, KIMI_FULL)
                }
                KIMI_ME -> HttpResponse(200, """{"profile":{"level":"Ultra"}}""")
                else -> error("unexpected ${request.url}")
            }
        }
        val snapshot = KimiClient(transport).fetch("sk-kimi", nowSeconds = 1_700_000_000)
        assertEquals(ProviderId.KIMI, snapshot.id)
        assertEquals("Ultra", snapshot.plan)
        assertEquals(1_700_000_000L, snapshot.updatedAt)
        assertEquals(
            listOf(
                ProviderWindow("5 小时窗口", 25.0, 5L * 3600L, epoch("2026-10-13T08:00:00Z")),
                ProviderWindow("本周额度", 50.0, 7L * 24L * 3600L, epoch("2026-10-20T00:00:00Z")),
                ProviderWindow("本月额度", 12.5, 30L * 24L * 3600L, epoch("2026-11-01T00:00:00Z")),
            ),
            snapshot.windows,
        )
        assertEquals(ProviderBooster(15.0, "CNY", 2.0), snapshot.booster)
        assertNull(snapshot.balance)
        assertNull(snapshot.credits)
        assertEquals(listOf(KIMI_USAGES, KIMI_ME), transport.requests.map { it.url })
    }

    @Test fun kimiFallsBackToMonthTotalWhenMonthCodeMissing() {
        val transport = ScriptedTransport { request ->
            when (request.url) {
                KIMI_USAGES -> HttpResponse(200, KIMI_PARTIAL)
                KIMI_ME -> HttpResponse(200, "{}")
                else -> error("unexpected ${request.url}")
            }
        }
        val snapshot = KimiClient(transport).fetch("sk-kimi", nowSeconds = 20)
        assertNull(snapshot.plan)
        assertEquals(
            listOf(
                ProviderWindow("5 小时窗口", 0.0, 5L * 3600L, epoch("2026-11-01T00:00:00Z")),
                ProviderWindow("本月额度", 100.0, 30L * 24L * 3600L, null),
            ),
            snapshot.windows,
        )
        assertNull(snapshot.booster)
    }

    @Test fun kimiUnauthorizedDoesNotLeakSecret() {
        val transport = ScriptedTransport { request ->
            assertEquals(KIMI_USAGES, request.url)
            HttpResponse(401, "secret-body-should-not-leak")
        }
        try {
            KimiClient(transport).fetch("sk-secret-key", nowSeconds = 1)
            fail("expected auth failure")
        } catch (error: ProviderAuthException) {
            assertEquals("Kimi Code API Key 无效或已过期", error.message)
            assertFalse(error.toString().contains("sk-secret-key"))
            assertFalse(error.toString().contains("secret-body"))
        }
        assertEquals(1, transport.requests.size)
    }

    @Test fun kimiMeFailureLeavesUsageIntact() {
        val transport = ScriptedTransport { request ->
            when (request.url) {
                KIMI_USAGES -> HttpResponse(200, KIMI_FULL)
                KIMI_ME -> throw IOException("me down")
                else -> error("unexpected ${request.url}")
            }
        }
        val snapshot = KimiClient(transport).fetch("sk-kimi", nowSeconds = 9)
        assertNull(snapshot.plan)
        assertEquals(3, snapshot.windows.size)
        assertEquals(ProviderBooster(15.0, "CNY", 2.0), snapshot.booster)
        assertEquals(9L, snapshot.updatedAt)
    }

    @Test fun deepSeekPrefersCnyAndParsesStringAmounts() {
        val transport = ScriptedTransport { request ->
            assertEquals(DEEPSEEK_BALANCE, request.url)
            assertEquals("GET", request.method)
            assertEquals("Bearer sk-deepseek", request.headers["Authorization"])
            HttpResponse(200, DEEPSEEK_CNY)
        }
        val snapshot = DeepSeekClient(transport).fetch("sk-deepseek", nowSeconds = 40)
        assertEquals(ProviderId.DEEPSEEK, snapshot.id)
        assertEquals("api", snapshot.plan)
        assertEquals(40L, snapshot.updatedAt)
        assertTrue(snapshot.windows.isEmpty())
        assertEquals(ProviderBalance(10.25, "CNY", 2.0, 8.25, true), snapshot.balance)
        assertNull(snapshot.credits)
        assertNull(snapshot.booster)
    }

    @Test fun deepSeekUsesFirstBalanceWhenCnyMissing() {
        val snapshot = DeepSeekClient { _ ->
            HttpResponse(
                200,
                """
                {"is_available":false,"balance_infos":[
                  {"currency":"USD","total_balance":"3.5","granted_balance":"1.5","topped_up_balance":"2"}
                ]}
                """.trim(),
            )
        }.fetch("sk-deepseek", nowSeconds = 41)
        assertEquals(ProviderBalance(3.5, "USD", 1.5, 2.0, false), snapshot.balance)
    }

    @Test fun deepSeekUnauthorized() {
        try {
            DeepSeekClient { _ -> HttpResponse(401, "secret-balance") }.fetch("sk-secret", nowSeconds = 1)
            fail("expected auth failure")
        } catch (error: ProviderAuthException) {
            assertEquals("DeepSeek API Key 无效或已过期", error.message)
            assertFalse(error.toString().contains("sk-secret"))
            assertFalse(error.toString().contains("secret-balance"))
        }
    }

    @Test fun mimoParsesUsageAndDetail() {
        val cookie = "session=abc; token=xyz"
        val transport = ScriptedTransport { request ->
            assertEquals("GET", request.method)
            assertEquals(cookie, request.headers["Cookie"])
            assertEquals("application/json", request.headers["Accept"])
            when (request.url) {
                MIMO_USAGE -> HttpResponse(200, MIMO_USAGE_BODY)
                MIMO_DETAIL -> HttpResponse(200, MIMO_DETAIL_BODY)
                else -> error("unexpected ${request.url}")
            }
        }
        val snapshot = MimoClient(transport).fetch(cookie, nowSeconds = 80)
        assertEquals(ProviderId.MIMO, snapshot.id)
        assertEquals("mimo-pro", snapshot.plan)
        assertEquals(80L, snapshot.updatedAt)
        assertEquals(
            listOf(ProviderWindow("套餐额度", 25.0, 0L, 1_800_000_000L)),
            snapshot.windows,
        )
        assertEquals(ProviderCredits(1.0, 2.0, 1_800_000_000L), snapshot.credits)
        assertNull(snapshot.balance)
        assertEquals(listOf(MIMO_USAGE, MIMO_DETAIL), transport.requests.map { it.url })
        assertFalse(snapshot.toString().contains(cookie))
    }

    @Test fun mimoCode401IsAuthFailure() {
        val transport = ScriptedTransport { request ->
            assertEquals(MIMO_USAGE, request.url)
            HttpResponse(200, """{"code":401,"message":"cookie-secret"}""")
        }
        try {
            MimoClient(transport).fetch("cookie=secret", nowSeconds = 1)
            fail("expected auth failure")
        } catch (error: ProviderAuthException) {
            assertEquals("小米账号登录已过期，请重新登录", error.message)
            assertFalse(error.toString().contains("cookie"))
        }
        assertEquals(1, transport.requests.size)
    }

    @Test fun mimoDetailFailureKeepsUsage() {
        val transport = ScriptedTransport { request ->
            when (request.url) {
                MIMO_USAGE -> HttpResponse(200, MIMO_USAGE_BODY)
                MIMO_DETAIL -> throw IOException("detail down")
                else -> error("unexpected ${request.url}")
            }
        }
        val snapshot = MimoClient(transport).fetch("cookie=ok", nowSeconds = 81)
        assertNull(snapshot.plan)
        assertEquals(ProviderWindow("套餐额度", 25.0, 0L, null), snapshot.windows.single())
        assertEquals(ProviderCredits(1.0, 2.0, null), snapshot.credits)
        assertEquals(listOf(MIMO_USAGE, MIMO_DETAIL), transport.requests.map { it.url })
    }

    @Test fun codexUsageMapsToProviderWindows() {
        val both = UsageSnapshot(
            planType = "plus",
            updatedAt = 50,
            primary = UsageWindow(23.5, 999, 80),
            secondary = UsageWindow(4.0, 12_345, 90),
        ).toProviderSnapshot()
        assertEquals(ProviderId.CODEX, both.id)
        assertEquals("plus", both.plan)
        assertEquals(50L, both.updatedAt)
        assertEquals(
            listOf(
                ProviderWindow("5 小时限额", 23.5, 5L * 3600L, 80),
                ProviderWindow("本周限额", 4.0, 7L * 24L * 3600L, 90),
            ),
            both.windows,
        )
        assertNull(both.hint)

        val weeklyOnly = UsageSnapshot(
            planType = "pro",
            updatedAt = 51,
            primary = null,
            secondary = UsageWindow(8.0, 604_800, 90),
        ).toProviderSnapshot()
        assertEquals(listOf(ProviderWindow("本周限额", 8.0, 7L * 24L * 3600L, 90)), weeklyOnly.windows)
        assertEquals("当前套餐无 5 小时限额", weeklyOnly.hint)

        val empty = UsageSnapshot("free", 52, null, null).toProviderSnapshot()
        assertTrue(empty.windows.isEmpty())
        assertNull(empty.hint)
        assertEquals("free", empty.plan)
    }

    @Test fun providerSnapshotCacheRoundTripsEveryField() {
        val full = ProviderSnapshot(
            id = ProviderId.KIMI,
            plan = "ultra",
            updatedAt = 3_000_000_000L,
            windows = listOf(
                ProviderWindow("本月额度", 12.5, 2_592_000, 3_000_000_100L),
                ProviderWindow("5 小时窗口", 0.0, 18_000, null),
            ),
            balance = ProviderBalance(10.25, "CNY", null, 8.25, false),
            credits = ProviderCredits(1.0, 2.0, 3_000_000_100L),
            booster = ProviderBooster(15.0, "USD", null),
            hint = "当前套餐无 5 小时限额",
        )
        val encoded = full.toCacheJson()
        assertEquals("kimi", JSONObject(encoded).getString("id"))
        assertEquals(full, parseCachedProviderSnapshot(encoded))

        val sparse = ProviderSnapshot(
            id = ProviderId.CODEX,
            plan = null,
            updatedAt = 0,
            windows = emptyList(),
            balance = null,
            credits = null,
            booster = null,
            hint = null,
        )
        assertEquals(sparse, parseCachedProviderSnapshot(sparse.toCacheJson()))
        assertEquals("codex", JSONObject(sparse.toCacheJson()).getString("id"))
        assertNull(parseCachedProviderSnapshot("not-json"))
        assertNull(parseCachedProviderSnapshot("{}"))
    }

    private fun epoch(text: String): Long = OffsetDateTime.parse(text).toEpochSecond()

    private class ScriptedTransport(
        private val handler: (HttpRequest) -> HttpResponse,
    ) : CodexTransport {
        val requests = mutableListOf<HttpRequest>()
        override fun execute(request: HttpRequest): HttpResponse {
            requests += request
            return handler(request)
        }
    }

    private companion object {
        const val KIMI_USAGES = "https://api.kimi.com/coding/v1/usages"
        const val KIMI_ME = "https://api.kimi.com/coding/v1/me"
        const val DEEPSEEK_BALANCE = "https://api.deepseek.com/user/balance"
        const val MIMO_USAGE = "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage"
        const val MIMO_DETAIL = "https://platform.xiaomimimo.com/api/v1/tokenPlan/detail"
        val KIMI_FULL = """
            {"usages":{
              "limit5h":{"usedRatio":0.25,"resetAt":"2026-10-13T16:00:00+08:00"},
              "limit7d":{"usedRatio":0.5,"resetAt":"2026-10-20T00:00Z"},
              "monthCode":{"usedRatio":0.125,"resetAt":"2026-11-01T00:00:00.123Z"},
              "monthTotal":{"usedRatio":0.9,"resetAt":"2026-12-01T00:00:00Z"}
            },"boosterWallet":{"balanceCents":1500,"currency":"CNY","monthlyUsedCents":200}}
        """.trim()
        val KIMI_PARTIAL = """
            {"usages":{
              "limit5h":{"usedRatio":0,"resetAt":"2026-11-01T00:00:00"},
              "monthTotal":{"usedRatio":1}
            }}
        """.trim()
        val DEEPSEEK_CNY = """
            {"is_available":true,"balance_infos":[
              {"currency":"USD","total_balance":"1.50","granted_balance":"1.00","topped_up_balance":"0.50"},
              {"currency":"CNY","total_balance":"10.25","granted_balance":"2.00","topped_up_balance":"8.25"}
            ]}
        """.trim()
        val MIMO_USAGE_BODY = """
            {"code":0,"data":{"usage":{"percent":0.25,"items":[
              {"name":"plan_total_token","used":1,"limit":2},
              {"name":"month_total_token","used":1200,"limit":10000}
            ]}}}
        """.trim()
        val MIMO_DETAIL_BODY = """
            {"code":0,"data":{"planName":"MiMo-Pro","periodEnd":1800000000000}}
        """.trim()
    }
}
