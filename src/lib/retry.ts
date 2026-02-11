/**
 * 429 重试策略
 * 解析 Google API 返回的 retryDelay 并提供智能退避
 */

/**
 * 解析 Duration 字符串 (e.g., "1.5s", "200ms", "1h16m0.667s")
 */
export function parseDurationMs(durationStr: string): number | null {
    const regex = /([\d.]+)\s*(ms|s|m|h)/g
    let totalMs = 0
    let matched = false

    let match: RegExpExecArray | null
    while ((match = regex.exec(durationStr)) !== null) {
        matched = true
        const value = parseFloat(match[1])
        const unit = match[2]

        switch (unit) {
            case "ms":
                totalMs += value
                break
            case "s":
                totalMs += value * 1000
                break
            case "m":
                totalMs += value * 60 * 1000
                break
            case "h":
                totalMs += value * 60 * 60 * 1000
                break
        }
    }

    return matched ? Math.round(totalMs) : null
}

function parseRetryAfterHeader(retryAfterHeader?: string): number | null {
    if (!retryAfterHeader) {
        return null
    }
    const seconds = Number(retryAfterHeader)
    if (Number.isFinite(seconds)) {
        return Math.max(seconds, 0) * 1000
    }
    const parsedDate = Date.parse(retryAfterHeader)
    if (!Number.isNaN(parsedDate)) {
        return Math.max(parsedDate - Date.now(), 0)
    }
    return null
}

function parseRetryDelayFromText(errorText: string): number | null {
    const patterns: Array<RegExp> = [
        /try again in (\d+)m\s*(\d+)s/i,
        /(?:try again in|backoff for|wait)\s*(\d+)s/i,
        /quota will reset in (\d+) second/i,
        /retry after (\d+) second/i,
        /\(wait (\d+)s\)/i,
    ]

    for (const pattern of patterns) {
        const match = errorText.match(pattern)
        if (!match) continue
        if (match.length >= 3) {
            const minutes = Number(match[1])
            const seconds = Number(match[2])
            if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
                return (minutes * 60 + seconds) * 1000
            }
        } else if (match.length >= 2) {
            const seconds = Number(match[1])
            if (Number.isFinite(seconds)) {
                return seconds * 1000
            }
        }
    }
    return null
}

/**
 * 从 429 错误响应中提取 retry delay
 */
export function parseRetryDelay(errorText: string, retryAfterHeader?: string): number | null {
    const headerDelay = parseRetryAfterHeader(retryAfterHeader)
    if (headerDelay !== null) {
        return headerDelay
    }

    try {
        const json = JSON.parse(errorText)
        const details = json?.error?.details

        if (Array.isArray(details)) {
            // 方式1: RetryInfo.retryDelay
            for (const detail of details) {
                const typeStr = detail?.["@type"]
                if (typeof typeStr === "string" && typeStr.includes("RetryInfo")) {
                    const retryDelay = detail?.retryDelay
                    if (typeof retryDelay === "string") {
                        const parsed = parseDurationMs(retryDelay)
                        if (parsed !== null) return parsed
                    }
                }
            }

            // 方式2: metadata.quotaResetDelay
            for (const detail of details) {
                const quotaDelay = detail?.metadata?.quotaResetDelay
                if (typeof quotaDelay === "string") {
                    const parsed = parseDurationMs(quotaDelay)
                    if (parsed !== null) return parsed
                }
            }
        }

        const retryAfter = json?.error?.retry_after
        if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
            return retryAfter * 1000
        }
    } catch {
        // ignore JSON parse errors
    }

    return parseRetryDelayFromText(errorText)
}

/**
 * 重试策略枚举
 */
export type RetryStrategy =
    | { type: "no_retry" }
    | { type: "fixed_delay"; delayMs: number }
    | { type: "linear_backoff"; baseMs: number }
    | { type: "exponential_backoff"; baseMs: number; maxMs: number }

/**
 * 根据错误状态码和错误信息确定重试策略
 */
export function determineRetryStrategy(
    statusCode: number,
    errorText: string,
    retryAfterHeader?: string
): RetryStrategy {
    switch (statusCode) {
        case 429: {
            // 优先使用服务端返回的 Retry-After
            const delayMs = parseRetryDelay(errorText, retryAfterHeader)
            if (delayMs !== null) {
                // 添加 500ms 缓冲，最小 2 秒防止极高频无效重试，最大 30 秒
                const actualDelay = Math.min(Math.max(delayMs + 500, 2000), 30000)
                return { type: "fixed_delay", delayMs: actualDelay }
            }
            const lower = errorText.toLowerCase()
            // 检查是否是模型容量耗尽（GPU 不足）
            if (lower.includes("model_capacity") || lower.includes("capacity")) {
                // 模型容量耗尽：临时性问题，使用较短的固定延迟（15秒）
                return { type: "fixed_delay", delayMs: 15000 }
            }
            if (lower.includes("per minute") || lower.includes("rate limit") || lower.includes("too many requests")) {
                return { type: "linear_backoff", baseMs: 2000 }
            }
            // 检查是否是配额耗尽（需要更长等待）
            if (lower.includes("resource_exhausted") || lower.includes("quota")) {
                // 配额耗尽：使用更长的指数退避
                return { type: "exponential_backoff", baseMs: 5000, maxMs: 30000 }
            }
            // 普通限流：线性退避 2s, 4s, 6s
            return { type: "linear_backoff", baseMs: 2000 }
        }

        case 503:
        case 529:
            // 服务不可用 / 服务器过载 - 指数退避
            return { type: "exponential_backoff", baseMs: 1000, maxMs: 8000 }

        case 500:
            // 服务器内部错误 - 线性退避
            return { type: "linear_backoff", baseMs: 500 }

        case 401:
        case 403:
            // 认证/权限错误 - 快速重试（可能需要刷新 token）
            return { type: "fixed_delay", delayMs: 100 }

        default:
            return { type: "no_retry" }
    }
}

/**
 * 添加随机抖动（jitter）以避免惊群效应
 * @param delayMs 基础延迟时间
 * @param jitterPercent 抖动百分比（默认 20%）
 */
export function addJitter(delayMs: number, jitterPercent: number = 0.2): number {
    const jitter = delayMs * jitterPercent
    const randomOffset = (Math.random() * 2 - 1) * jitter // -jitter ~ +jitter
    return Math.max(0, Math.round(delayMs + randomOffset))
}

/**
 * 计算当前尝试的等待时间
 * 🆕 增加 jitter 支持，避免多个请求同时重试
 */
export function calculateRetryDelay(
    strategy: RetryStrategy,
    attempt: number,
    enableJitter: boolean = true
): number | null {
    let baseDelay: number | null = null

    switch (strategy.type) {
        case "no_retry":
            return null

        case "fixed_delay":
            baseDelay = strategy.delayMs
            break

        case "linear_backoff":
            baseDelay = strategy.baseMs * (attempt + 1)
            break

        case "exponential_backoff":
            baseDelay = Math.min(strategy.baseMs * Math.pow(2, attempt), strategy.maxMs)
            break
    }

    // 🆕 添加 jitter 避免惊群效应
    if (baseDelay !== null && enableJitter) {
        return addJitter(baseDelay)
    }

    return baseDelay
}

/**
 * 执行退避等待
 * 🆕 支持 jitter
 */
export async function applyRetryDelay(
    strategy: RetryStrategy,
    attempt: number,
    enableJitter: boolean = true
): Promise<boolean> {
    const delayMs = calculateRetryDelay(strategy, attempt, enableJitter)
    if (delayMs === null) {
        return false
    }
    await new Promise(resolve => setTimeout(resolve, delayMs))
    return true
}
