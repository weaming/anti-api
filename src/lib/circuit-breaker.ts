/**
 * 断路器模式实现
 * 防止级联失败，在服务故障时快速失败
 */

export enum CircuitState {
    /** 关闭状态：正常运行 */
    CLOSED = "closed",
    
    /** 打开状态：快速失败，不调用服务 */
    OPEN = "open",
    
    /** 半开状态：允许少量探测请求 */
    HALF_OPEN = "half_open"
}

export interface CircuitBreakerConfig {
    /** 失败次数阈值，超过此值打开断路器 */
    failureThreshold: number
    
    /** 成功次数阈值（半开状态），达到后关闭断路器 */
    successThreshold: number
    
    /** 超时时间（ms），打开后多久尝试半开 */
    timeout: number
    
    /** 半开状态允许的并发探测请求数 */
    halfOpenMaxCalls: number
}

export interface CircuitBreakerMetrics {
    state: CircuitState
    failureCount: number
    successCount: number
    lastFailureTime: number | null
    lastSuccessTime: number | null
    nextAttemptTime: number | null
}

/**
 * 断路器类
 */
export class CircuitBreaker {
    private state: CircuitState = CircuitState.CLOSED
    private failureCount: number = 0
    private successCount: number = 0
    private lastFailureTime: number | null = null
    private lastSuccessTime: number | null = null
    private nextAttemptTime: number | null = null
    private halfOpenCalls: number = 0
    
    // 🆕 告警回调
    private onStateChangeCallbacks: Array<(state: CircuitState, breaker: CircuitBreaker) => void> = []
    
    constructor(
        private readonly name: string,
        private readonly config: CircuitBreakerConfig
    ) {}
    
    /**
     * 🆕 注册状态变化回调（用于告警）
     */
    onStateChange(callback: (state: CircuitState, breaker: CircuitBreaker) => void): void {
        this.onStateChangeCallbacks.push(callback)
    }
    
    /**
     * 🆕 触发状态变化回调
     */
    private notifyStateChange(): void {
        for (const callback of this.onStateChangeCallbacks) {
            try {
                callback(this.state, this)
            } catch (error) {
                console.error(`[CircuitBreaker:${this.name}] Callback error:`, error)
            }
        }
    }

    /**
     * 判断是否允许请求通过
     */
    canAttempt(): boolean {
        switch (this.state) {
            case CircuitState.CLOSED:
                return true
                
            case CircuitState.OPEN: {
                const now = Date.now()
                if (this.nextAttemptTime && now >= this.nextAttemptTime) {
                    // 尝试进入半开状态
                    this.transitionToHalfOpen()
                    return true
                }
                return false
            }
                
            case CircuitState.HALF_OPEN:
                // 半开状态允许有限的并发请求
                return this.halfOpenCalls < this.config.halfOpenMaxCalls
        }
    }

    /**
     * 记录成功
     */
    recordSuccess(): void {
        this.lastSuccessTime = Date.now()
        
        switch (this.state) {
            case CircuitState.CLOSED:
                // 关闭状态下成功，重置失败计数
                this.failureCount = 0
                break
                
            case CircuitState.HALF_OPEN:
                this.successCount++
                this.halfOpenCalls--
                
                if (this.successCount >= this.config.successThreshold) {
                    // 达到成功阈值，关闭断路器
                    this.transitionToClosed()
                }
                break
        }
    }

    /**
     * 记录失败
     */
    recordFailure(): void {
        this.lastFailureTime = Date.now()
        
        switch (this.state) {
            case CircuitState.CLOSED:
                this.failureCount++
                
                if (this.failureCount >= this.config.failureThreshold) {
                    // 达到失败阈值，打开断路器
                    this.transitionToOpen()
                }
                break
                
            case CircuitState.HALF_OPEN:
                // 半开状态下失败，立即重新打开
                this.halfOpenCalls--
                this.transitionToOpen()
                break
        }
    }

    /**
     * 开始半开状态的调用
     */
    startHalfOpenCall(): void {
        if (this.state === CircuitState.HALF_OPEN) {
            this.halfOpenCalls++
        }
    }

    /**
     * 转换到关闭状态
     */
    private transitionToClosed(): void {
        console.log(`[CircuitBreaker:${this.name}] Transitioning to CLOSED`)
        this.state = CircuitState.CLOSED
        this.failureCount = 0
        this.successCount = 0
        this.halfOpenCalls = 0
        this.nextAttemptTime = null
        this.notifyStateChange() // 🆕 触发告警
    }

    /**
     * 转换到打开状态
     */
    private transitionToOpen(): void {
        console.log(`[CircuitBreaker:${this.name}] Transitioning to OPEN (failures: ${this.failureCount})`)
        this.state = CircuitState.OPEN
        this.nextAttemptTime = Date.now() + this.config.timeout
        this.halfOpenCalls = 0
        this.notifyStateChange() // 🆕 触发告警
    }

    /**
     * 转换到半开状态
     */
    private transitionToHalfOpen(): void {
        console.log(`[CircuitBreaker:${this.name}] Transitioning to HALF_OPEN`)
        this.state = CircuitState.HALF_OPEN
        this.successCount = 0
        this.failureCount = 0
        this.halfOpenCalls = 0
        this.notifyStateChange() // 🆕 触发告警
    }

    /**
     * 获取当前状态
     */
    getState(): CircuitState {
        return this.state
    }

    /**
     * 获取指标
     */
    getMetrics(): CircuitBreakerMetrics {
        return {
            state: this.state,
            failureCount: this.failureCount,
            successCount: this.successCount,
            lastFailureTime: this.lastFailureTime,
            lastSuccessTime: this.lastSuccessTime,
            nextAttemptTime: this.nextAttemptTime
        }
    }

    /**
     * 获取断路器名称
     */
    getName(): string {
        return this.name
    }

    /**
     * 手动重置断路器
     */
    reset(): void {
        console.log(`[CircuitBreaker:${this.name}] Manual reset`)
        this.transitionToClosed()
    }
}

/**
 * 断路器管理器
 * 管理多个断路器实例（如每个账号一个）
 */
export class CircuitBreakerManager {
    private breakers = new Map<string, CircuitBreaker>()
    
    constructor(private readonly defaultConfig: CircuitBreakerConfig) {}

    /**
     * 获取或创建断路器
     */
    getBreaker(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
        if (!this.breakers.has(name)) {
            const finalConfig = { ...this.defaultConfig, ...config }
            this.breakers.set(name, new CircuitBreaker(name, finalConfig))
        }
        return this.breakers.get(name)!
    }

    /**
     * 移除断路器
     */
    removeBreaker(name: string): void {
        this.breakers.delete(name)
    }

    /**
     * 获取所有断路器的状态
     */
    getAllMetrics(): Map<string, CircuitBreakerMetrics> {
        const metrics = new Map<string, CircuitBreakerMetrics>()
        for (const [name, breaker] of this.breakers) {
            metrics.set(name, breaker.getMetrics())
        }
        return metrics
    }

    /**
     * 重置所有断路器
     */
    resetAll(): void {
        for (const breaker of this.breakers.values()) {
            breaker.reset()
        }
    }
}

// 默认配置
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
    failureThreshold: 5,        // 5 次失败后打开
    successThreshold: 2,        // 2 次成功后关闭
    timeout: 30000,             // 30 秒后尝试恢复
    halfOpenMaxCalls: 3         // 半开状态允许 3 个并发探测
}

// 全局断路器管理器（用于账号级别）
export const accountCircuitBreakers = new CircuitBreakerManager(DEFAULT_CIRCUIT_BREAKER_CONFIG)
