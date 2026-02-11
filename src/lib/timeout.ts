/**
 * 多层超时保护
 * 提供连接超时、首字节超时、总超时等多重保护
 */

export interface TimeoutConfig {
    /** 连接超时（建立连接的最大时间） */
    connectionTimeout: number
    
    /** 首字节超时（从发送请求到收到第一个字节的最大时间） */
    firstByteTimeout: number
    
    /** 总超时（整个请求的最大时间） */
    totalTimeout: number
    
    /** 空闲超时（两次数据之间的最大间隔） */
    idleTimeout: number
}

export interface TimeoutResult<T> {
    success: boolean
    data?: T
    error?: Error
    timedOut: boolean
    timeoutType?: 'connection' | 'firstByte' | 'total' | 'idle'
}

/**
 * 默认超时配置
 */
export const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = {
    connectionTimeout: 5000,      // 5 秒
    firstByteTimeout: 15000,      // 15 秒
    totalTimeout: 90000,          // 90 秒（非流式）
    idleTimeout: 30000            // 30 秒
}

/**
 * 流式请求的超时配置
 */
export const STREAMING_TIMEOUT_CONFIG: TimeoutConfig = {
    connectionTimeout: 5000,      // 5 秒
    firstByteTimeout: 15000,      // 15 秒
    totalTimeout: 1800000,        // 30 分钟
    idleTimeout: 30000            // 30 秒
}

/**
 * 带多层超时保护的 fetch
 */
export async function fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    config: TimeoutConfig = DEFAULT_TIMEOUT_CONFIG
): Promise<Response> {
    const controller = new AbortController()
    const timeoutIds: NodeJS.Timeout[] = []
    let timedOut = false
    let timeoutType: 'connection' | 'firstByte' | 'total' | 'idle' | undefined

    try {
        // 合并信号
        if (options.signal) {
            if (options.signal.aborted) {
                controller.abort()
            } else {
                options.signal.addEventListener('abort', () => controller.abort(), { once: true })
            }
        }

        // 总超时
        const totalTimeoutId = setTimeout(() => {
            timedOut = true
            timeoutType = 'total'
            controller.abort()
        }, config.totalTimeout)
        timeoutIds.push(totalTimeoutId)

        // 连接超时（在开始 fetch 后立即设置）
        const connectionTimeoutId = setTimeout(() => {
            if (!timedOut) {
                timedOut = true
                timeoutType = 'connection'
                controller.abort()
            }
        }, config.connectionTimeout)
        timeoutIds.push(connectionTimeoutId)

        // 执行 fetch
        const fetchPromise = fetch(url, {
            ...options,
            signal: controller.signal
        })

        const response = await fetchPromise

        // 清除连接超时（已成功连接）
        clearTimeout(connectionTimeoutId)

        // 设置首字节超时（等待响应体开始）
        const firstByteTimeoutId = setTimeout(() => {
            if (!timedOut) {
                timedOut = true
                timeoutType = 'firstByte'
                controller.abort()
            }
        }, config.firstByteTimeout)
        timeoutIds.push(firstByteTimeoutId)

        // 读取至少一个字节以确认响应开始
        if (response.body) {
            const reader = response.body.getReader()
            try {
                await reader.read() // 读取第一块
                reader.releaseLock() // 立即释放，让后续代码继续使用
            } catch (e) {
                // 如果读取失败，可能是超时
                if (timedOut) {
                    throw new Error(`Request timeout (${timeoutType})`)
                }
                throw e
            }
        }

        // 清除首字节超时
        clearTimeout(firstByteTimeoutId)

        return response
    } catch (error) {
        if (timedOut) {
            const timeoutError = new Error(`Request timeout: ${timeoutType}`)
            ;(timeoutError as any).timeout = true
            ;(timeoutError as any).timeoutType = timeoutType
            throw timeoutError
        }
        throw error
    } finally {
        // 清除所有定时器
        timeoutIds.forEach(id => clearTimeout(id))
    }
}

/**
 * 带空闲超时的流式读取
 */
export async function* streamWithIdleTimeout<T>(
    stream: AsyncIterable<T>,
    idleTimeoutMs: number
): AsyncGenerator<T, void, unknown> {
    let lastChunkTime = Date.now()
    let idleTimeoutId: NodeJS.Timeout | null = null
    let timedOut = false

    const checkIdleTimeout = () => {
        const elapsed = Date.now() - lastChunkTime
        if (elapsed >= idleTimeoutMs) {
            timedOut = true
            throw new Error(`Stream idle timeout (${Math.round(elapsed / 1000)}s)`)
        }
    }

    // 启动空闲检测定时器
    idleTimeoutId = setInterval(checkIdleTimeout, Math.min(idleTimeoutMs / 2, 5000))

    try {
        for await (const chunk of stream) {
            if (timedOut) {
                break
            }

            lastChunkTime = Date.now()
            yield chunk
        }
    } finally {
        if (idleTimeoutId) {
            clearInterval(idleTimeoutId)
        }
    }
}

/**
 * 包装 Promise 并添加超时
 */
export function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string = 'Operation timeout'
): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            setTimeout(() => {
                const error = new Error(timeoutMessage)
                ;(error as any).timeout = true
                reject(error)
            }, timeoutMs)
        })
    ])
}

/**
 * 检查错误是否为超时错误
 */
export function isTimeoutError(error: any): boolean {
    if (!error) return false
    
    return (
        error.timeout === true ||
        error.name === 'AbortError' ||
        error.message?.toLowerCase().includes('timeout') ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ESOCKETTIMEDOUT'
    )
}

/**
 * 获取超时类型
 */
export function getTimeoutType(error: any): string | null {
    if (!isTimeoutError(error)) return null
    
    if (error.timeoutType) {
        return error.timeoutType
    }
    
    const msg = error.message?.toLowerCase() || ''
    if (msg.includes('connection')) return 'connection'
    if (msg.includes('first byte')) return 'firstByte'
    if (msg.includes('idle')) return 'idle'
    if (msg.includes('total')) return 'total'
    
    return 'unknown'
}
