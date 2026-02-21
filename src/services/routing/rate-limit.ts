import { UpstreamError } from "~/lib/error"

const FALLBACK_STATUSES = new Set([401, 403, 408, 429, 500, 503, 529])

export function shouldFallbackOnUpstream(error: Error | unknown): boolean {
    if (error instanceof UpstreamError) {
        return FALLBACK_STATUSES.has(error.status)
    }
    return false
}

export interface AccountStickyState {
    cursor: number
}

const stickyStates = new Map<string, AccountStickyState>()

export function getAccountStickyState(model: string, entryCount: number): AccountStickyState {
    let state = stickyStates.get(model)
    if (!state) {
        state = { cursor: 0 }
        stickyStates.set(model, state)
    }
    // ensure cursor is valid
    if (state.cursor >= entryCount) {
        state.cursor = 0
    }
    return state
}

export function advanceAccountCursor(state: AccountStickyState, entryCount: number, currentCursor: number) {
    if (entryCount <= 1) return
    state.cursor = (currentCursor + 1) % entryCount
}

const routerRateLimits = new Map<string, number>()

/**
 * 获取限流 key
 * 支持账户级别和账户+模型级别的限流
 */
function getRateLimitKey(provider: string, accountId: string, modelId?: string): string {
    if (modelId) {
        return `${provider}:${accountId}:${modelId}`
    }
    return `${provider}:${accountId}`
}

/**
 * 检查账户是否被限流
 * 如果指定了 modelId，则只检查该模型是否被限流
 * 否则检查账户级别的限流
 */
export function isRouterRateLimited(provider: string, accountId: string, modelId?: string): boolean {
    const key = getRateLimitKey(provider, accountId, modelId)
    const until = routerRateLimits.get(key)
    if (!until) return false
    if (Date.now() > until) {
        routerRateLimits.delete(key)
        return false
    }
    return true
}

/**
 * 标记账户/模型组合为限流
 * 如果指定了 modelId，则只限流该模型
 * 否则限流整个账户
 */
export function markRouterRateLimited(provider: string, accountId: string, durationMs: number, modelId?: string) {
    const key = getRateLimitKey(provider, accountId, modelId)
    routerRateLimits.set(key, Date.now() + durationMs)
}

/**
 * 清除指定账户/模型的限流状态
 */
export function clearRouterRateLimit(provider: string, accountId: string, modelId?: string) {
    const key = getRateLimitKey(provider, accountId, modelId)
    routerRateLimits.delete(key)
}
