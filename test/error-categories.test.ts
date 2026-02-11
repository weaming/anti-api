import { test, expect, describe } from "bun:test"
import { classifyError, ErrorCategory } from "~/lib/error-categories"

describe("Error Classification", () => {
    test("classifies 401 as AUTH_ERROR", () => {
        const classification = classifyError(401, "Unauthorized")
        
        expect(classification.category).toBe(ErrorCategory.AUTH_ERROR)
        expect(classification.shouldRetry).toBe(true)
        expect(classification.shouldRefreshToken).toBe(true)
        expect(classification.shouldSwitchAccount).toBe(false)
    })

    test("classifies 403 as AUTH_ERROR", () => {
        const classification = classifyError(403, "Forbidden")
        
        expect(classification.category).toBe(ErrorCategory.AUTH_ERROR)
        expect(classification.shouldRefreshToken).toBe(true)
    })

    test("classifies quota exhausted 429", () => {
        const errorText = JSON.stringify({
            error: {
                message: "Quota exhausted",
                details: [{ reason: "QUOTA_EXHAUSTED" }]
            }
        })
        
        const classification = classifyError(429, errorText)
        
        expect(classification.category).toBe(ErrorCategory.QUOTA_EXHAUSTED)
        expect(classification.shouldSwitchAccount).toBe(true)
        expect(classification.maxRetries).toBe(1)
    })

    test("classifies rate limit 429", () => {
        const errorText = "Rate limit exceeded. Try again in 30s"
        
        const classification = classifyError(429, errorText)
        
        expect(classification.category).toBe(ErrorCategory.RATE_LIMIT)
        expect(classification.shouldRetry).toBe(true)
        expect(classification.shouldSwitchAccount).toBe(false)
    })

    test("classifies model capacity error", () => {
        const errorText = "Model capacity exhausted"
        
        const classification = classifyError(429, errorText)
        
        expect(classification.category).toBe(ErrorCategory.CAPACITY_ERROR)
        expect(classification.shouldRetry).toBe(true)
        expect(classification.suggestedDelayMs).toBe(15000)
    })

    test("classifies 4xx as CLIENT_ERROR", () => {
        const classification = classifyError(400, "Bad request")
        
        expect(classification.category).toBe(ErrorCategory.CLIENT_ERROR)
        expect(classification.shouldRetry).toBe(false)
        expect(classification.maxRetries).toBe(0)
    })

    test("classifies 500 as TRANSIENT", () => {
        const classification = classifyError(500, "Internal server error")
        
        expect(classification.category).toBe(ErrorCategory.TRANSIENT)
        expect(classification.shouldRetry).toBe(true)
        expect(classification.shouldSwitchAccount).toBe(false)
    })

    test("classifies 503 as SERVICE_ERROR", () => {
        const classification = classifyError(503, "Service unavailable")
        
        expect(classification.category).toBe(ErrorCategory.SERVICE_ERROR)
        expect(classification.shouldRetry).toBe(true)
        expect(classification.shouldSwitchAccount).toBe(true)
    })

    test("parses Retry-After header", () => {
        const classification = classifyError(429, "", "10")
        
        expect(classification.suggestedDelayMs).toBeGreaterThanOrEqual(10000)
    })

    test("handles unknown errors", () => {
        // 999 状态码会被归类为 5xx (服务器错误)，因为 >= 500
        // 使用真正未定义的错误场景
        const classification = classifyError(0, "Network error")
        
        expect(classification.category).toBe(ErrorCategory.UNKNOWN)
        expect(classification.shouldRetry).toBe(false)
    })

    test("distinguishes quota from rate limit in RESOURCE_EXHAUSTED", () => {
        const quotaError = JSON.stringify({
            error: {
                status: "RESOURCE_EXHAUSTED",
                details: [{ reason: "QUOTA_EXHAUSTED" }]
            }
        })
        
        const rateLimitError = JSON.stringify({
            error: {
                status: "RESOURCE_EXHAUSTED",
                message: "Too many requests per minute"
            }
        })
        
        const quotaClass = classifyError(429, quotaError)
        const rateLimitClass = classifyError(429, rateLimitError)
        
        expect(quotaClass.category).toBe(ErrorCategory.QUOTA_EXHAUSTED)
        expect(rateLimitClass.category).toBe(ErrorCategory.RATE_LIMIT)
    })
})
