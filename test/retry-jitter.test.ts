import { test, expect, describe } from "bun:test"
import { addJitter, calculateRetryDelay, parseRetryDelay, parseDurationMs } from "~/lib/retry"

describe("Retry with Jitter", () => {
    test("addJitter adds random offset", () => {
        const baseDelay = 1000
        const results: number[] = []
        
        // 生成多个 jitter 值
        for (let i = 0; i < 100; i++) {
            const jittered = addJitter(baseDelay, 0.2)
            results.push(jittered)
        }
        
        // 验证范围：800ms - 1200ms
        const min = Math.min(...results)
        const max = Math.max(...results)
        
        expect(min).toBeGreaterThanOrEqual(800)
        expect(max).toBeLessThanOrEqual(1200)
        
        // 验证有足够的随机性（标准差应该大于0）
        const avg = results.reduce((a, b) => a + b) / results.length
        const variance = results.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / results.length
        const stdDev = Math.sqrt(variance)
        
        expect(stdDev).toBeGreaterThan(0)
    })

    test("addJitter returns non-negative values", () => {
        const smallDelay = 10
        for (let i = 0; i < 50; i++) {
            const jittered = addJitter(smallDelay, 0.5)
            expect(jittered).toBeGreaterThanOrEqual(0)
        }
    })

    test("calculateRetryDelay with jitter enabled", () => {
        const strategy = { type: "fixed_delay" as const, delayMs: 1000 }
        const results: number[] = []
        
        for (let i = 0; i < 20; i++) {
            const delay = calculateRetryDelay(strategy, 0, true)
            if (delay !== null) {
                results.push(delay)
            }
        }
        
        // 验证所有值都在合理范围内
        expect(results.every(d => d >= 800 && d <= 1200)).toBe(true)
        
        // 验证有变化（不是所有值都相同）
        const uniqueValues = new Set(results)
        expect(uniqueValues.size).toBeGreaterThan(1)
    })

    test("calculateRetryDelay without jitter is deterministic", () => {
        const strategy = { type: "exponential_backoff" as const, baseMs: 1000, maxMs: 8000 }
        
        const delay1 = calculateRetryDelay(strategy, 2, false)
        const delay2 = calculateRetryDelay(strategy, 2, false)
        
        expect(delay1).toBe(delay2)
        expect(delay1).toBe(4000) // 1000 * 2^2
    })

    test("parseDurationMs handles various formats", () => {
        expect(parseDurationMs("1.5s")).toBe(1500)
        expect(parseDurationMs("200ms")).toBe(200)
        expect(parseDurationMs("1m30s")).toBe(90000)
        expect(parseDurationMs("1h")).toBe(3600000)
        expect(parseDurationMs("1h16m0.667s")).toBeCloseTo(4560667, 0)
    })

    test("parseRetryDelay extracts delay from JSON", () => {
        const errorJson = JSON.stringify({
            error: {
                details: [{
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    retryDelay: "5s"
                }]
            }
        })
        
        expect(parseRetryDelay(errorJson)).toBe(5000)
    })

    test("parseRetryDelay handles quota reset delay", () => {
        const errorJson = JSON.stringify({
            error: {
                details: [{
                    metadata: {
                        quotaResetDelay: "2m30s"
                    }
                }]
            }
        })
        
        expect(parseRetryDelay(errorJson)).toBe(150000)
    })
})
