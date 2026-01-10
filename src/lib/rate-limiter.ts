/**
 * Rate Limiter + Request Queue
 * 确保 API 调用间隔 ≥ minInterval，并且同一时间只有一个请求在处理
 *
 * 重要：Google API 对高频请求和并发请求非常敏感
 * - 间隔至少 1500ms
 * - 同时只允许一个请求
 */

class RateLimiter {
    private minInterval: number
    private lastCall: number | null = null
    private queue: Promise<void> = Promise.resolve()

    constructor(minIntervalMs: number = 1500) {
        this.minInterval = minIntervalMs
    }

    /**
     * 等待获取请求许可
     * 确保：
     * 1. 请求按顺序串行处理
     * 2. 每次请求之间间隔至少 minInterval 毫秒
     */
    async wait(): Promise<void> {
        // 将新请求加入队列尾部
        const currentQueue = this.queue
        let resolveNext: () => void

        this.queue = new Promise(resolve => {
            resolveNext = resolve
        })

        // 等待前面的请求完成
        await currentQueue

        // 检查时间间隔
        if (this.lastCall !== null) {
            const elapsed = Date.now() - this.lastCall
            if (elapsed < this.minInterval) {
                const waitTime = this.minInterval - elapsed
                await new Promise(resolve => setTimeout(resolve, waitTime))
            }
        }

        this.lastCall = Date.now()

        // 释放队列锁（允许下一个请求开始等待间隔）
        resolveNext!()
    }

    /**
     * 获取独占锁，直到请求完成才释放
     * 用于确保完全串行处理（同时只有一个请求在进行）
     * 返回的释放函数只能调用一次
     */
    async acquireExclusive(): Promise<() => void> {
        const currentQueue = this.queue
        let resolveNext: () => void
        let released = false

        this.queue = new Promise(resolve => {
            resolveNext = resolve
        })

        // 等待前面的请求完成
        await currentQueue

        // 检查时间间隔
        if (this.lastCall !== null) {
            const elapsed = Date.now() - this.lastCall
            if (elapsed < this.minInterval) {
                const waitTime = this.minInterval - elapsed
                await new Promise(resolve => setTimeout(resolve, waitTime))
            }
        }

        this.lastCall = Date.now()

        // 返回释放函数，调用者在请求完成后调用
        // 使用 released 标志防止重复释放
        return () => {
            if (!released) {
                released = true
                this.lastCall = Date.now()
                resolveNext!()
            }
        }
    }
}

// 全局单例，确保所有请求共享同一个限流器
// 间隔设置为 2000ms（2秒），更保守的设置
export const rateLimiter = new RateLimiter(2000)
