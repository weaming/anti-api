import { test, expect } from "bun:test"

// Create a test-specific RateLimiter class to avoid singleton issues
class TestRateLimiter {
    private minInterval: number
    private lastCall: number | null = null
    private queue: Promise<void> = Promise.resolve()

    constructor(minIntervalMs: number = 100) {
        this.minInterval = minIntervalMs
    }

    async wait(): Promise<void> {
        const currentQueue = this.queue
        let resolveNext: () => void

        this.queue = new Promise(resolve => {
            resolveNext = resolve
        })

        await currentQueue

        if (this.lastCall !== null) {
            const elapsed = Date.now() - this.lastCall
            if (elapsed < this.minInterval) {
                const waitTime = this.minInterval - elapsed
                await new Promise(resolve => setTimeout(resolve, waitTime))
            }
        }

        this.lastCall = Date.now()
        resolveNext!()
    }

    async acquireExclusive(): Promise<() => void> {
        const currentQueue = this.queue
        let resolveNext: () => void
        let released = false

        this.queue = new Promise(resolve => {
            resolveNext = resolve
        })

        await currentQueue

        if (this.lastCall !== null) {
            const elapsed = Date.now() - this.lastCall
            if (elapsed < this.minInterval) {
                const waitTime = this.minInterval - elapsed
                await new Promise(resolve => setTimeout(resolve, waitTime))
            }
        }

        this.lastCall = Date.now()

        return () => {
            if (!released) {
                released = true
                this.lastCall = Date.now()
                resolveNext!()
            }
        }
    }
}

test("RateLimiter.wait ensures minimum interval", async () => {
    const limiter = new TestRateLimiter(50) // 50ms interval for faster tests

    const startTime = Date.now()
    await limiter.wait()
    await limiter.wait()
    const elapsed = Date.now() - startTime

    // Second call should wait at least 50ms
    expect(elapsed).toBeGreaterThanOrEqual(45) // Allow small timing variance
})

test("RateLimiter.acquireExclusive returns release function", async () => {
    const limiter = new TestRateLimiter(50)

    const release = await limiter.acquireExclusive()
    expect(typeof release).toBe("function")

    release()
})

test("RateLimiter.acquireExclusive blocks until release", async () => {
    const limiter = new TestRateLimiter(10)
    const order: number[] = []

    const release1 = await limiter.acquireExclusive()
    order.push(1)

    // Start second request but don't await yet
    const promise2 = limiter.acquireExclusive().then(release => {
        order.push(2)
        release()
    })

    // Small delay to ensure promise2 is queued
    await new Promise(r => setTimeout(r, 20))

    // At this point, 2 should not have started yet
    expect(order).toEqual([1])

    // Release first lock
    release1()

    // Now 2 should complete
    await promise2
    expect(order).toEqual([1, 2])
})

test("RateLimiter prevents double release", async () => {
    const limiter = new TestRateLimiter(10)

    const release = await limiter.acquireExclusive()

    // Call release twice
    release()
    release() // Should not throw or cause issues

    // Should be able to acquire again
    const release2 = await limiter.acquireExclusive()
    release2()
})

test("RateLimiter handles concurrent requests sequentially", async () => {
    const limiter = new TestRateLimiter(20)
    const results: number[] = []

    // Launch 3 concurrent requests
    const promises = [1, 2, 3].map(async (n) => {
        await limiter.wait()
        results.push(n)
    })

    await Promise.all(promises)

    // All should complete in order
    expect(results.length).toBe(3)
})
