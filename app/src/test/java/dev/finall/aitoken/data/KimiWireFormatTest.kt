package dev.finall.aitoken.data

import org.junit.Assert.*
import org.junit.Test

class KimiWireFormatTest {
    @Test fun officialWireNamesAreParsedWithoutCliNormalization() {
        val snapshot = parseKimiUsages("""{
          "usages": {
            "limit_5h": {"used_ratio": "0.12", "reset_time": "2026-10-13T12:00:00Z"},
            "limit_7d": {"used_ratio": 0.64},
            "limit_month_code": {"used_ratio": 0.41}
          },
          "boosterWallet": {
            "balance": {"type": "BOOSTER", "amount": 10000000000, "amountLeft": 8650000000},
            "monthlyUsed": {"priceInCents": 1350, "currency": "CNY"}
          }
        }""", null, 100L)
        assertEquals(3, snapshot.windows.size)
        assertEquals(12.0, snapshot.windows[0].usedPercent, 0.0001)
        assertNotNull(snapshot.windows[0].resetAt)
        assertEquals(64.0, snapshot.windows[1].usedPercent, 0.0001)
        assertEquals(41.0, snapshot.windows[2].usedPercent, 0.0001)
        assertEquals(86.5, snapshot.booster!!.amount, 0.0001)
        assertEquals(13.5, snapshot.booster!!.monthlyUsed!!, 0.0001)
        assertEquals("CNY", snapshot.booster!!.currency)
    }
}
