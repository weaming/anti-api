/**
 * 统一错误分类系统
 * 根据错误类型提供不同的处理策略
 */

export enum ErrorCategory {
    /** 瞬时错误：网络抖动、临时故障，应重试同账号 */
    TRANSIENT = "transient",
    
    /** 速率限制：短期限流，等待后重试或切换账号 */
    RATE_LIMIT = "rate_limit",
    
    /** 配额耗尽：长期配额用完，需切换账号 */
    QUOTA_EXHAUSTED = "quota_exhausted",
    
    /** 认证错误：Token 过期或无效，需刷新 */
    AUTH_ERROR = "auth_error",
    
    /** 服务错误：上游服务故障，应降级或快速失败 */
    SERVICE_ERROR = "service_error",
    
    /** 客户端错误：请求格式错误，不应重试 */
    CLIENT_ERROR = "client_error",
    
    /** 模型容量错误：GPU 资源不足，短暂等待 */
    CAPACITY_ERROR = "capacity_error",
    
    /** 未知错误 */
    UNKNOWN = "unknown"
}

export interface ErrorClassification {
    category: ErrorCategory
    shouldRetry: boolean
    shouldSwitchAccount: boolean
    shouldRefreshToken: boolean
    suggestedDelayMs: number | null
    maxRetries: number
}

/**
 * 根据状态码和错误内容分类错误
 */
export function classifyError(
    statusCode: number,
    errorText: string,
    retryAfter?: string
): ErrorClassification {
    const lower = errorText.toLowerCase()

    // 401/403: 认证错误
    if (statusCode === 401 || statusCode === 403) {
        return {
            category: ErrorCategory.AUTH_ERROR,
            shouldRetry: true,
            shouldSwitchAccount: false,
            shouldRefreshToken: true,
            suggestedDelayMs: 100,
            maxRetries: 2
        }
    }

    // 429: 需要区分配额耗尽和速率限制
    if (statusCode === 429) {
        // 检查是否配额耗尽
        const isQuotaExhausted = 
            lower.includes("quota_exhausted") ||
            lower.includes("quota") && lower.includes("reset") ||
            (lower.includes("resource_exhausted") && lower.includes("quota"))

        if (isQuotaExhausted) {
            return {
                category: ErrorCategory.QUOTA_EXHAUSTED,
                shouldRetry: true,
                shouldSwitchAccount: true,
                shouldRefreshToken: false,
                suggestedDelayMs: parseRetryAfterMs(retryAfter) || 60000,
                maxRetries: 1 // 立即切换，不多次重试
            }
        }

        // 检查是否模型容量耗尽
        const isCapacityError = 
            lower.includes("model_capacity") ||
            lower.includes("capacity") && lower.includes("exhausted")

        if (isCapacityError) {
            return {
                category: ErrorCategory.CAPACITY_ERROR,
                shouldRetry: true,
                shouldSwitchAccount: false,
                shouldRefreshToken: false,
                suggestedDelayMs: 15000,
                maxRetries: 3
            }
        }

        // 普通速率限制
        return {
            category: ErrorCategory.RATE_LIMIT,
            shouldRetry: true,
            shouldSwitchAccount: false, // 先重试，多次失败再切换
            shouldRefreshToken: false,
            suggestedDelayMs: parseRetryAfterMs(retryAfter) || 2000,
            maxRetries: 3
        }
    }

    // 4xx: 客户端错误
    if (statusCode >= 400 && statusCode < 500) {
        return {
            category: ErrorCategory.CLIENT_ERROR,
            shouldRetry: false,
            shouldSwitchAccount: false,
            shouldRefreshToken: false,
            suggestedDelayMs: null,
            maxRetries: 0
        }
    }

    // 500: 服务器内部错误（可能是瞬时的）
    if (statusCode === 500) {
        return {
            category: ErrorCategory.TRANSIENT,
            shouldRetry: true,
            shouldSwitchAccount: false,
            shouldRefreshToken: false,
            suggestedDelayMs: 1000,
            maxRetries: 3
        }
    }

    // 503/529: 服务不可用
    if (statusCode === 503 || statusCode === 529) {
        return {
            category: ErrorCategory.SERVICE_ERROR,
            shouldRetry: true,
            shouldSwitchAccount: true,
            shouldRefreshToken: false,
            suggestedDelayMs: 5000,
            maxRetries: 2
        }
    }

    // 5xx: 其他服务器错误
    if (statusCode >= 500) {
        return {
            category: ErrorCategory.SERVICE_ERROR,
            shouldRetry: true,
            shouldSwitchAccount: false,
            shouldRefreshToken: false,
            suggestedDelayMs: 3000,
            maxRetries: 2
        }
    }

    // 未知错误
    return {
        category: ErrorCategory.UNKNOWN,
        shouldRetry: false,
        shouldSwitchAccount: false,
        shouldRefreshToken: false,
        suggestedDelayMs: null,
        maxRetries: 0
    }
}

/**
 * 解析 Retry-After 头
 */
function parseRetryAfterMs(retryAfter?: string): number | null {
    if (!retryAfter) return null
    
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) {
        return Math.max(seconds, 0) * 1000
    }
    
    const parsedDate = Date.parse(retryAfter)
    if (!Number.isNaN(parsedDate)) {
        return Math.max(parsedDate - Date.now(), 0)
    }
    
    return null
}

/**
 * 获取错误分类的描述
 */
export function getErrorCategoryDescription(category: ErrorCategory): string {
    switch (category) {
        case ErrorCategory.TRANSIENT:
            return "Transient error (network/temporary)"
        case ErrorCategory.RATE_LIMIT:
            return "Rate limit exceeded"
        case ErrorCategory.QUOTA_EXHAUSTED:
            return "Quota exhausted"
        case ErrorCategory.AUTH_ERROR:
            return "Authentication error"
        case ErrorCategory.SERVICE_ERROR:
            return "Service unavailable"
        case ErrorCategory.CLIENT_ERROR:
            return "Client error (invalid request)"
        case ErrorCategory.CAPACITY_ERROR:
            return "Model capacity exhausted"
        case ErrorCategory.UNKNOWN:
            return "Unknown error"
    }
}
