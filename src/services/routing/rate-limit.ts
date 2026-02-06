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

export function isRouterRateLimited(provider: string, accountId: string): boolean {
    const key = `${provider}:${accountId}`
    const until = routerRateLimits.get(key)
    if (!until) return false
    if (Date.now() > until) {
        routerRateLimits.delete(key)
        return false
    }
    return true
}

export function markRouterRateLimited(provider: string, accountId: string, durationMs: number) {
    const key = `${provider}:${accountId}`
    routerRateLimits.set(key, Date.now() + durationMs)
}
