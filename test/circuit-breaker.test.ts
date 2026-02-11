import { test, expect, describe, beforeEach } from "bun:test"
import { CircuitBreaker, CircuitState, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "~/lib/circuit-breaker"

describe("CircuitBreaker", () => {
    let breaker: CircuitBreaker

    beforeEach(() => {
        breaker = new CircuitBreaker("test-breaker", {
            ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
            timeout: 100, // 短超时以加快测试
        })
    })

    test("starts in CLOSED state", () => {
        expect(breaker.getState()).toBe(CircuitState.CLOSED)
        expect(breaker.canAttempt()).toBe(true)
    })

    test("opens after threshold failures", () => {
        // 默认阈值是 5
        for (let i = 0; i < 5; i++) {
            breaker.recordFailure()
        }
        
        expect(breaker.getState()).toBe(CircuitState.OPEN)
        expect(breaker.canAttempt()).toBe(false)
    })

    test("stays CLOSED with successful calls", () => {
        breaker.recordSuccess()
        breaker.recordSuccess()
        breaker.recordSuccess()
        
        expect(breaker.getState()).toBe(CircuitState.CLOSED)
    })

    test("resets failure count on success in CLOSED state", () => {
        breaker.recordFailure()
        breaker.recordFailure()
        breaker.recordSuccess()
        
        const metrics = breaker.getMetrics()
        expect(metrics.failureCount).toBe(0)
    })

    test("transitions to HALF_OPEN after timeout", async () => {
        // 触发打开
        for (let i = 0; i < 5; i++) {
            breaker.recordFailure()
        }
        
        expect(breaker.getState()).toBe(CircuitState.OPEN)
        
        // 等待超时
        await new Promise(resolve => setTimeout(resolve, 150))
        
        // 现在应该允许尝试（进入半开状态）
        expect(breaker.canAttempt()).toBe(true)
        expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
    })

    test("HALF_OPEN transitions to CLOSED after success threshold", async () => {
        // 打开断路器
        for (let i = 0; i < 5; i++) {
            breaker.recordFailure()
        }
        
        // 等待进入半开
        await new Promise(resolve => setTimeout(resolve, 150))
        breaker.canAttempt() // 触发转换到 HALF_OPEN
        
        // 记录成功（默认阈值是 2）
        breaker.recordSuccess()
        expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
        
        breaker.recordSuccess()
        expect(breaker.getState()).toBe(CircuitState.CLOSED)
    })

    test("HALF_OPEN transitions back to OPEN on failure", async () => {
        // 打开断路器
        for (let i = 0; i < 5; i++) {
            breaker.recordFailure()
        }
        
        // 等待进入半开
        await new Promise(resolve => setTimeout(resolve, 150))
        breaker.canAttempt()
        
        expect(breaker.getState()).toBe(CircuitState.HALF_OPEN)
        
        // 失败应该重新打开
        breaker.recordFailure()
        expect(breaker.getState()).toBe(CircuitState.OPEN)
    })

    test("limits concurrent calls in HALF_OPEN state", async () => {
        const customBreaker = new CircuitBreaker("test", {
            failureThreshold: 3,
            successThreshold: 2,
            timeout: 100,
            halfOpenMaxCalls: 2, // 只允许 2 个并发
        })
        
        // 打开断路器
        for (let i = 0; i < 3; i++) {
            customBreaker.recordFailure()
        }
        
        // 等待进入半开
        await new Promise(resolve => setTimeout(resolve, 150))
        
        expect(customBreaker.canAttempt()).toBe(true)
        customBreaker.startHalfOpenCall()
        
        expect(customBreaker.canAttempt()).toBe(true)
        customBreaker.startHalfOpenCall()
        
        // 第三次应该被拒绝
        expect(customBreaker.canAttempt()).toBe(false)
    })

    test("reset() returns to CLOSED state", () => {
        // 打开断路器
        for (let i = 0; i < 5; i++) {
            breaker.recordFailure()
        }
        
        expect(breaker.getState()).toBe(CircuitState.OPEN)
        
        breaker.reset()
        
        expect(breaker.getState()).toBe(CircuitState.CLOSED)
        expect(breaker.canAttempt()).toBe(true)
        
        const metrics = breaker.getMetrics()
        expect(metrics.failureCount).toBe(0)
        expect(metrics.successCount).toBe(0)
    })

    test("getMetrics returns correct data", () => {
        breaker.recordFailure()
        breaker.recordFailure()
        
        const metrics = breaker.getMetrics()
        
        expect(metrics.state).toBe(CircuitState.CLOSED)
        expect(metrics.failureCount).toBe(2)
        expect(metrics.lastFailureTime).toBeDefined()
        expect(metrics.lastFailureTime).toBeGreaterThan(0)
    })
})
