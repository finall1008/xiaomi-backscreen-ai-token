package dev.finall.aitoken.data

import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

class MimoWireFormatTest {
    @Test fun yearlyPlanUsesActualCodeAndLocalExpiry() {
        val detail = parseMimoDetail("""{"code":0,"data":{"planCode":"lite:year","planName":"Lite","currentPeriodEnd":"2027-07-09 23:59:59"}}""")!!
        val end = LocalDateTime.of(2027, 7, 9, 23, 59, 59).atZone(ZoneId.of("Asia/Shanghai")).toEpochSecond()
        assertEquals("Lite · 年度套餐", detail.plan)
        assertEquals(end, detail.periodEnd)
        val usage = parseMimoUsage("""{"code":0,"data":{"monthUsage":{"percent":0.5},"usage":{"percent":0.14,"items":[{"name":"month_total_token","used":5,"limit":10},{"name":"plan_total_token","used":14,"limit":100}]}}}""", detail, 1)
        assertEquals("年度额度", usage.windows.single().title)
        assertEquals(14.0, usage.windows.single().usedPercent, 0.00001)
        assertEquals(end, usage.windows.single().resetAt)
        assertEquals(14.0, usage.credits!!.used, 0.0)
        assertEquals(100.0, usage.credits!!.limit, 0.0)
        assertEquals(end, usage.credits!!.periodEnd)
    }

    @Test fun monthlyAndUnknownCyclesAreNotAssumedYearlyOrMonthly() {
        val monthly = parseMimoDetail("""{"code":0,"data":{"planCode":"pro:month","planName":"Pro","currentPeriodEnd":"2026-11-01T00:00:00Z"}}""")!!
        assertEquals("Pro · 月度套餐", monthly.plan)
        val body = """{"code":0,"data":{"usage":{"percent":0.1}}}"""
        assertEquals("本月额度", parseMimoUsage(body, monthly, 1).windows.single().title)
        val unknown = parseMimoUsage(body, null, 1).windows.single()
        assertEquals("套餐额度", unknown.title)
        assertEquals(0L, unknown.windowSeconds)
        assertNull(unknown.resetAt)
    }
}
