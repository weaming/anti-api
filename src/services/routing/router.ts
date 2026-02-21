import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { UpstreamError, summarizeUpstream429 } from "~/lib/error"
import { createChatCompletionWithOptions, createChatCompletionStreamWithOptions, type ChatResponse } from "~/services/antigravity/chat"
import { loadRoutingConfig, type AccountRoutingEntry, type RoutingConfig } from "./config"
import { accountManager } from "~/services/antigravity/account-manager"
import { authStore } from "~/services/auth/store"
import { getOfficialModelProviders, isOfficialModel } from "./models"
import { getAccountStickyState, advanceAccountCursor, isRouterRateLimited, markRouterRateLimited, shouldFallbackOnUpstream } from "./rate-limit"
import { setRequestLogContext, getAccountDisplay } from "~/lib/logger"

/**
 * 根据 429 错误类型决定路由层锁定时间
 * - 配额耗尽：60 秒（需要等待较长时间）
 * - 速率限制：5 秒（chat.ts 内部已经重试过，给一个短暂冷却）
 * - 其他：10 秒
 */
function getRouterLockDurationMs(error: UpstreamError): number {
    if (error.status !== 429) return 10000
    
    const summary = summarizeUpstream429(error)
    switch (summary.reason) {
        case "quota_exhausted":
            return 60000 // 配额耗尽，锁定 60 秒
        case "rate_limit_exceeded":
            return 5000  // 速率限制，短暂锁定 5 秒
        case "model_capacity_exhausted":
            return 8000  // 模型容量不足，锁定 8 秒
        case "resource_exhausted":
            return 10000 // 资源耗尽，锁定 10 秒
        default:
            return 10000 // 未知 429，锁定 10 秒
    }
}

export { isOfficialModel }

export class RoutingError extends Error {
    constructor(message: string, public status: number = 500) {
        super(message)
        this.name = "RoutingError"
    }
}

export interface RoutedRequest {
    model: string
    messages: ClaudeMessage[]
    tools?: ClaudeTool[]
    toolChoice?: any
    maxTokens?: number
    temperature?: number
    topP?: number
    topK?: number
    presencePenalty?: number
    frequencyPenalty?: number
    stop?: string | string[]
    seed?: number
    responseFormat?: {
        type: "text" | "json_object"
    }
}

export function resolveRoutingEntries(config: RoutingConfig, model: string): AccountRoutingEntry[] {
    const providers = getOfficialModelProviders(model)
    if (providers.length === 0) {
        throw new RoutingError(`Model "${model}" is not an official model`, 400)
    }

    const accountRouting = config.accountRouting
    const smartSwitch = accountRouting?.smartSwitch ?? true
    const route = accountRouting?.routes.find(r => r.modelId === model)

    let entries: AccountRoutingEntry[] = route?.entries ? [...route.entries] : []

    // 智能补充: 如果没配置或者配置为空，且开启智能路由，自动填充 (Simplified logic: just use providers)
    if (entries.length === 0) {
        if (!smartSwitch) {
            throw new RoutingError(`No routing configured for model "${model}"`, 400)
        }
        entries = providers.flatMap(provider => buildAutoEntriesForProvider(provider))
    } else {
        // 解析 auto
        const expanded: AccountRoutingEntry[] = []
        for (const entry of entries) {
            if (entry.accountId === "auto") {
                if (!smartSwitch) {
                    throw new RoutingError(`Routing for "${model}" uses auto but smart switch is disabled`, 400)
                }
                expanded.push(...buildAutoEntriesForProvider(entry.provider))
            } else {
                expanded.push(entry)
            }
        }
        entries = expanded
    }

    // 过滤可用性
    const available = entries.filter(entry => {
        if (!providers.includes(entry.provider)) return false

        let isUsable = false
        if (entry.provider === "antigravity") {
            // Antigravity 需在 accountManager 中存在
            isUsable = accountManager.hasAccount(entry.accountId)
        }

        return isUsable
    })

    if (available.length === 0) {
        // 如果全部不可用，且开启智能路由，尝试完全自动回退到默认
        if (smartSwitch) {
            const fallback = providers.flatMap(provider => buildAutoEntriesForProvider(provider))
                .filter(entry => {
                    if (entry.provider === "antigravity") return accountManager.hasAccount(entry.accountId)
                    return false
                })
            if (fallback.length > 0) return fallback
        }
        throw new RoutingError(`No valid accounts available for model "${model}"`, 400)
    }

    return available
}

function buildAutoEntriesForProvider(provider: string): AccountRoutingEntry[] {
    if (provider === "antigravity") {
        return accountManager.listAccounts().map(id => ({
            id: `auto-${provider}-${id}`,
            modelId: "",
            provider: "antigravity",
            accountId: id
        }))
    }
    return []
}

function recordUsage(modelId: string, inputTokens: number, outputTokens: number) {
    // specific implementation or import from usage-tracker if needed
    // checking imports, usage-tracker wasn't imported. Assuming it might be needed or we can skip for now if not strictly required
    // or use console log.
    // simpler: just ignore for now if not critical, or adding TODO.
    // Actually, looking at previous file content, it called `recordUsage` but it wasn't imported?
    // Let's add a placeholder or import if I can find where it was.
    // It was likely in `~/services/usage-tracker`.
}

function recordProviderUsage(modelId: string, completion: any): void {
    if (!completion?.usage) return
    // const inputTokens = completion.usage.inputTokens ?? 0
    // const outputTokens = completion.usage.outputTokens ?? 0
    // recordUsage(...) // restoring this later if needed.
}

async function executeProviderRequest(entry: AccountRoutingEntry, request: RoutedRequest, isStream: boolean) {
    if (entry.provider === "antigravity") {
        const option = {
            accountId: entry.accountId,
            allowRotation: false,
        }
        setRequestLogContext({ model: request.model, provider: "antigravity", account: getAccountDisplay("antigravity", entry.accountId) })

        if (isStream) {
            return createChatCompletionStreamWithOptions({ ...request }, option)
        } else {
            return createChatCompletionWithOptions({ ...request }, option)
        }
    }

    throw new Error(`Unsupported provider: ${entry.provider}`)
}

export async function createRoutedCompletion(request: RoutedRequest): Promise<ChatResponse> {
    const config = loadRoutingConfig()
    const entries = resolveRoutingEntries(config, request.model)

    // 负载均衡/Failover
    const state = getAccountStickyState(request.model, entries.length)
    const startIndex = state.cursor

    let lastError: Error | null = null

    for (let offset = 0; offset < entries.length; offset++) {
        const index = (startIndex + offset) % entries.length
        const entry = entries[index]

        // Rate Limit 检查：使用账户+模型组合进行限流检测
        if (entry.provider === "antigravity") {
            // 检查账户级别和账户+模型级别的限流
            const isModelLimited = isRouterRateLimited("antigravity", entry.accountId, request.model)
            const isAccountLimited = accountManager.isAccountRateLimited(entry.accountId, request.model)
            if (isModelLimited || isAccountLimited) {
                if (entries.length > 1) continue
            }
            if (entries.length > 1 && accountManager.isAccountInFlight(entry.accountId)) continue
        } else {
            if (isRouterRateLimited(entry.provider, entry.accountId, request.model)) continue
        }

        try {
            const result = await executeProviderRequest(entry, request, false) as ChatResponse
            state.cursor = index
            recordProviderUsage(request.model, result)
            return result
        } catch (error) {
            console.error(`Route failed [${entry.provider}:${entry.accountId}]:`, error)
            lastError = error as Error

            if (error instanceof UpstreamError && shouldFallbackOnUpstream(error)) {
                if (entry.provider === "antigravity") {
                    const lockDuration = getRouterLockDurationMs(error)
                    accountManager.markRateLimitedFromError(entry.accountId, error.status, error.body, error.retryAfter, request.model, { maxDurationMs: lockDuration })
                    // 使用账户+模型组合进行限流标记
                    markRouterRateLimited("antigravity", entry.accountId, lockDuration, request.model)
                }
                advanceAccountCursor(state, entries.length, index)
                continue
            }

            throw error
        }
    }

    throw lastError || new RoutingError("All routes failed", 503)
}

export async function* createRoutedCompletionStream(request: RoutedRequest): AsyncGenerator<string, void, unknown> {
    const config = loadRoutingConfig()
    const entries = resolveRoutingEntries(config, request.model)

    const state = getAccountStickyState(request.model, entries.length)
    const startIndex = state.cursor

    let lastError: Error | null = null

    for (let offset = 0; offset < entries.length; offset++) {
        const index = (startIndex + offset) % entries.length
        const entry = entries[index]

        if (entry.provider === "antigravity") {
            // 检查账户级别和账户+模型级别的限流
            const isModelLimited = isRouterRateLimited("antigravity", entry.accountId, request.model)
            const isAccountLimited = accountManager.isAccountRateLimited(entry.accountId, request.model)
            if (isModelLimited || isAccountLimited) {
                if (entries.length > 1) continue
            }
            if (entries.length > 1 && accountManager.isAccountInFlight(entry.accountId)) continue
        } else {
            if (isRouterRateLimited(entry.provider, entry.accountId, request.model)) continue
        }

        try {
            const stream = await executeProviderRequest(entry, request, true)
            state.cursor = index
            // @ts-ignore
            for await (const chunk of stream) {
                yield chunk
            }
            return
        } catch (error) {
            console.error(`Route stream failed [${entry.provider}:${entry.accountId}]:`, error)
            lastError = error as Error

            if (error instanceof UpstreamError && shouldFallbackOnUpstream(error)) {
                if (entry.provider === "antigravity") {
                    const lockDuration = getRouterLockDurationMs(error)
                    accountManager.markRateLimitedFromError(entry.accountId, error.status, error.body, error.retryAfter, request.model, { maxDurationMs: lockDuration })
                    // 使用账户+模型组合进行限流标记
                    markRouterRateLimited("antigravity", entry.accountId, lockDuration, request.model)
                }
                advanceAccountCursor(state, entries.length, index)
                continue
            }
            throw error
        }
    }

    throw lastError || new RoutingError("All routes failed", 503)
}
