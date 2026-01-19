import { test, expect } from "bun:test"
import { parseDurationMs, parseRetryDelay } from "../src/lib/retry"

test("parseDurationMs handles composite durations", () => {
    expect(parseDurationMs("200ms")).toBe(200)
    expect(parseDurationMs("1.5s")).toBe(1500)
    expect(parseDurationMs("2m30s")).toBe(150000)
    expect(parseDurationMs("1h16m0.667s")).toBe(4560667)
})

test("parseDurationMs returns null on invalid input", () => {
    expect(parseDurationMs("n/a")).toBeNull()
})

test("parseRetryDelay prefers retry-after header", () => {
    expect(parseRetryDelay("{}", "5")).toBe(5000)
})

test("parseRetryDelay reads RetryInfo retryDelay", () => {
    const errorText = JSON.stringify({
        error: {
            details: [
                {
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    retryDelay: "1.5s",
                },
            ],
        },
    })
    expect(parseRetryDelay(errorText)).toBe(1500)
})

test("parseRetryDelay reads quotaResetDelay metadata", () => {
    const errorText = JSON.stringify({
        error: {
            details: [
                {
                    metadata: { quotaResetDelay: "2s" },
                },
            ],
        },
    })
    expect(parseRetryDelay(errorText)).toBe(2000)
})

test("parseRetryDelay parses text fallback", () => {
    expect(parseRetryDelay("try again in 2m 3s")).toBe(123000)
})
