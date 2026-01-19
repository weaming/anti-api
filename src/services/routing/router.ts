import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { UpstreamError } from "~/lib/error"
import { createChatCompletionWithOptions, createChatCompletionStreamWithOptions } from "~/services/antigravity/chat"
import { accountManager } from "~/services/antigravity/account-manager"
import { createCodexCompletion } from "~/services/codex/chat"
import { createCopilotCompletion } from "~/services/copilot/chat"
import { authStore } from "~/services/auth/store"
import type { ProviderAccount } from "~/services/auth/types"
import { loadRoutingConfig, type RoutingEntry, type RoutingConfig, type AccountRoutingEntry } from "./config"
import { getProviderModels, isHiddenCodexModel } from "./models"
import { buildMessageStart, buildContentBlockStart, buildTextDelta, buildInputJsonDelta, buildContentBlockStop, buildMessageDelta, buildMessageStop } from "~/lib/translator"
import { formatLogTime, setRequestLogContext } from "~/lib/logger"
import type { AuthProvider } from "~/services/auth/types"

export class RoutingError extends Error {
    status: number
    constructor(message: string, status: number = 400) {
        super(message)
        this.name = "RoutingError"
        this.status = status
    }
}

interface RoutedRequest {
    model: string
    messages: ClaudeMessage[]
    tools?: ClaudeTool[]
    maxTokens?: number
}

function isEntryUsable(entry: RoutingEntry): boolean {
    if (entry.provider === "antigravity") {
        return true
    }
    return !!authStore.getAccount(entry.provider, entry.accountId)
}

// 🆕 Router 级别的 rate-limit 状态（独立于 accountManager）
const routerRateLimits = new Map<string, number>()  // "provider:accountId" -> expiry timestamp
const PROVIDER_ORDER: AuthProvider[] = ["antigravity", "codex", "copilot"]
let officialModelIndex: Map<string, Set<AuthProvider>> | null = null

function getRouterRateLimitKey(provider: string, accountId: string): string {
    return `${provider}:${accountId}`
}

function isRouterRateLimited(provider: string, accountId: string): boolean {
    const key = getRouterRateLimitKey(provider, accountId)
    const expiry = routerRateLimits.get(key)
    if (!expiry) return false
    if (Date.now() > expiry) {
        routerRateLimits.delete(key)
        return false
    }
    return true
}

function markRouterRateLimited(provider: string, accountId: string, durationMs: number = 30000): void {
    const key = getRouterRateLimitKey(provider, accountId)
    routerRateLimits.set(key, Date.now() + durationMs)
}

function buildOfficialModelIndex(): Map<string, Set<AuthProvider>> {
    const index = new Map<string, Set<AuthProvider>>()
    for (const provider of PROVIDER_ORDER) {
        const models = getProviderModels(provider)
        for (const model of models) {
            const key = model.id
            if (!index.has(key)) {
                index.set(key, new Set<AuthProvider>())
            }
            index.get(key)!.add(provider)
        }
    }
    return index
}

function getOfficialModelProviders(model: string): AuthProvider[] {
    if (!officialModelIndex) {
        officialModelIndex = buildOfficialModelIndex()
    }
    return Array.from(officialModelIndex.get(model) || [])
}

function isOfficialModel(model: string): boolean {
    return getOfficialModelProviders(model).length > 0
}

function normalizeEntries(entries: RoutingEntry[]): RoutingEntry[] {
    return entries.filter(entry => {
        if (entry.provider === "codex" && isHiddenCodexModel(entry.modelId)) {
            return false
        }
        if (!isEntryUsable(entry)) return false
        // 🆕 Antigravity 账号需检查是否存在于 accountManager
        if (entry.provider === "antigravity" && entry.accountId !== "auto") {
            if (!accountManager.hasAccount(entry.accountId)) {
                return false
            }
        }
        return true
    })
}

function listProviderAccountsInOrder(provider: AuthProvider): ProviderAccount[] {
    const accounts = authStore.listAccounts(provider)
    return accounts.sort((a, b) => {
        const aTime = a.createdAt || ""
        const bTime = b.createdAt || ""
        if (aTime && bTime) {
            return aTime.localeCompare(bTime)
        }
        if (aTime) return -1
        if (bTime) return 1
        return 0
    })
}

function buildAutoEntriesForProvider(provider: AuthProvider): AccountRoutingEntry[] {
    const accounts = listProviderAccountsInOrder(provider)
    return accounts.map(account => ({
        id: crypto.randomUUID(),
        provider,
        accountId: account.id,
        accountLabel: account.label || account.email || account.login || account.id,
    }))
}

function resolveAccountRoutingEntries(config: RoutingConfig, model: string): AccountRoutingEntry[] {
    const providers = getOfficialModelProviders(model)
    if (providers.length === 0) {
        throw new RoutingError(`Model "${model}" is not an official model`, 400)
    }

    const accountRouting = config.accountRouting
    const smartSwitch = accountRouting?.smartSwitch ?? false
    const route = accountRouting?.routes.find(r => r.modelId === model)

    let entries: AccountRoutingEntry[] = route?.entries ? [...route.entries] : []

    if (entries.length === 0) {
        if (!smartSwitch) {
            throw new RoutingError(`No account routing configured for model "${model}"`, 400)
        }
        entries = providers.flatMap(provider => buildAutoEntriesForProvider(provider))
    } else {
        const expanded: AccountRoutingEntry[] = []
        for (const entry of entries) {
            if (entry.accountId === "auto") {
                if (!smartSwitch) {
                    throw new RoutingError(`Account routing for "${model}" includes auto entries but smart switch is disabled`, 400)
                }
                expanded.push(...buildAutoEntriesForProvider(entry.provider))
                continue
            }
            expanded.push(entry)
        }
        entries = expanded
    }

    let filtered = entries.filter(entry => providers.includes(entry.provider))

    let valid = filtered.filter(entry => {
        if (!isEntryUsable(entry as RoutingEntry)) return false
        if (entry.provider === "antigravity" && entry.accountId !== "auto") {
            return accountManager.hasAccount(entry.accountId)
        }
        return true
    })

    if (valid.length === 0 && smartSwitch) {
        filtered = providers.flatMap(provider => buildAutoEntriesForProvider(provider))
        valid = filtered.filter(entry => {
            if (!isEntryUsable(entry as RoutingEntry)) return false
            if (entry.provider === "antigravity" && entry.accountId !== "auto") {
                return accountManager.hasAccount(entry.accountId)
            }
            return true
        })
    }

    if (valid.length === 0) {
        throw new RoutingError(`No valid account routing entries for model "${model}"`, 400)
    }

    return valid
}

function getAccountDisplay(provider: AuthProvider, accountId: string): string {
    const account = authStore.getAccount(provider, accountId)
    return account?.login || account?.email || account?.label || accountId
}

const FALLBACK_STATUSES = new Set([401, 403, 408, 429, 500, 503, 529])

function isAccountUnavailableError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return error.message.startsWith("Account not found:")
}

function isTransientTransportError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return /certificate|fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed out/i.test(error.message)
}

function shouldFallbackOnUpstream(error: UpstreamError): boolean {
    return FALLBACK_STATUSES.has(error.status)
}

function getFlowKey(model: string): string {
    const raw = model?.trim() || ""
    if (raw.toLowerCase().startsWith("route:")) {
        return raw.slice("route:".length).trim()
    }
    return raw
}

function selectFlowEntries(config: RoutingConfig, model: string): RoutingEntry[] {
    const { flows } = config
    if (flows.length === 0) {
        return []
    }

    const raw = model?.trim() || ""
    const isRoute = raw.toLowerCase().startsWith("route:")
    const flowKey = getFlowKey(model)
    const exact = flows.find(flow => flow.name === flowKey)
    if (exact) {
        return exact.entries
    }

    if (isRoute) {
        return []
    }

    // 🆕 没有匹配到 flow，返回空数组
    return []
}

function resolveFlowEntries(config: RoutingConfig, model: string): RoutingEntry[] {
    const entries = normalizeEntries(selectFlowEntries(config, model))
    if (entries.length === 0) {
        throw new RoutingError(`No flow routing entries configured for model "${model}"`, 400)
    }
    return entries
}

function resolveAccountEntries(config: RoutingConfig, model: string): AccountRoutingEntry[] {
    return resolveAccountRoutingEntries(config, model)
}

async function createFlowCompletionWithEntries(request: RoutedRequest, entries: RoutingEntry[]) {
    let lastError: Error | null = null

    for (const entry of entries) {
        try {
            if (entry.provider === "antigravity") {
                const accountId = entry.accountId === "auto" ? undefined : entry.accountId
                // Skip rate-limited antigravity accounts (check both accountManager and router-level)
                if (accountId && entries.length > 1) {
                    const isLimited = accountManager.isAccountRateLimited(accountId) || isRouterRateLimited("antigravity", accountId)
                    if (isLimited) continue
                }
                setRequestLogContext({ model: entry.modelId, provider: "antigravity", account: entry.accountId })
                return await createChatCompletionWithOptions({ ...request, model: entry.modelId }, {
                    accountId,
                    allowRotation: accountId ? false : true,
                })
            }

            if (authStore.isRateLimited(entry.provider, entry.accountId) && entries.length > 1) {
                continue
            }

            const account = authStore.getAccount(entry.provider, entry.accountId)
            if (!account) {
                continue
            }
            const accountDisplay = account.login || account.email || entry.accountId
            setRequestLogContext({ model: entry.modelId, provider: entry.provider, account: accountDisplay })

            if (entry.provider === "codex") {
                const startTime = Date.now()
                const result = await createCodexCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Codex >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
                return result
            }

            if (entry.provider === "copilot") {
                const startTime = Date.now()
                const result = await createCopilotCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Copilot >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
                return result
            }
        } catch (error) {
            lastError = error as Error
            if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
                continue
            }
            if (error instanceof UpstreamError && shouldFallbackOnUpstream(error)) {
                // 🆕 修复：标记 rate-limited（同时更新 accountManager 和 router 级别状态）
                if (entry.provider === "antigravity" && entry.accountId !== "auto") {
                    accountManager.markRateLimitedFromError(entry.accountId, error.status, error.body)
                    markRouterRateLimited("antigravity", entry.accountId, 60000)  // 🆕 Router 级别也标记
                } else if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, error.status, error.body, error.retryAfter)
                    markRouterRateLimited(entry.provider, entry.accountId, 60000)  // 🆕 Router 级别也标记
                }
                continue
            }
            if (isTransientTransportError(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
                }
                continue
            }
            throw error
        }
    }

    // 🆕 如果所有 entries 都被跳过（rate-limited），清除状态并重试第一个
    if (!lastError && entries.length > 0) {
        // 清除 router 级别的 rate-limit 状态
        for (const entry of entries) {
            routerRateLimits.delete(getRouterRateLimitKey(entry.provider, entry.accountId))
        }
        // 清除 accountManager 的 rate-limit 状态
        accountManager.clearAllRateLimits()

        // 重试第一个 entry
        const entry = entries[0]
        if (entry.provider === "antigravity") {
            const accountId = entry.accountId === "auto" ? undefined : entry.accountId
            setRequestLogContext({ model: entry.modelId, provider: "antigravity", account: entry.accountId })
            return await createChatCompletionWithOptions({ ...request, model: entry.modelId }, {
                accountId,
                allowRotation: accountId ? false : true,
            })
        }
    }

    if (lastError) {
        throw lastError
    }

    throw new RoutingError("No routing entries available", 400)
}

async function createAccountCompletionWithEntries(request: RoutedRequest, entries: AccountRoutingEntry[]) {
    let lastError: Error | null = null

    for (const entry of entries) {
        try {
            if (entry.provider === "antigravity") {
                if (entry.accountId === "auto") {
                    throw new RoutingError(`Account routing entry for "${request.model}" cannot use auto without smart switch expansion`, 400)
                }
                const isLimited = accountManager.isAccountRateLimited(entry.accountId) || isRouterRateLimited("antigravity", entry.accountId)
                if (isLimited) continue
                const accountDisplay = getAccountDisplay("antigravity", entry.accountId)
                setRequestLogContext({ model: request.model, provider: "antigravity", account: accountDisplay })
                return await createChatCompletionWithOptions({ ...request, model: request.model }, {
                    accountId: entry.accountId,
                    allowRotation: false,
                })
            }

            if (authStore.isRateLimited(entry.provider, entry.accountId)) {
                continue
            }

            const account = authStore.getAccount(entry.provider, entry.accountId)
            if (!account) {
                continue
            }
            const accountDisplay = account.login || account.email || entry.accountId
            setRequestLogContext({ model: request.model, provider: entry.provider, account: accountDisplay })

            if (entry.provider === "codex") {
                const startTime = Date.now()
                const result = await createCodexCompletion(account, request.model, request.messages, request.tools, request.maxTokens)
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Codex >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
                return result
            }

            if (entry.provider === "copilot") {
                const startTime = Date.now()
                const result = await createCopilotCompletion(account, request.model, request.messages, request.tools, request.maxTokens)
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Copilot >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
                return result
            }
        } catch (error) {
            lastError = error as Error
            if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
                continue
            }
            if (error instanceof UpstreamError && shouldFallbackOnUpstream(error)) {
                if (entry.provider === "antigravity") {
                    accountManager.markRateLimitedFromError(entry.accountId, error.status, error.body, error.retryAfter, request.model)
                    markRouterRateLimited("antigravity", entry.accountId, 60000)
                } else {
                    authStore.markRateLimited(entry.provider, entry.accountId, error.status, error.body, error.retryAfter)
                    markRouterRateLimited(entry.provider, entry.accountId, 60000)
                }
                continue
            }
            if (isTransientTransportError(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
                }
                continue
            }
            throw error
        }
    }

    if (lastError) {
        throw lastError
    }

    throw new RoutingError(`No account routing entries available for model "${request.model}"`, 400)
}

export async function createRoutedCompletion(request: RoutedRequest) {
    if (isHiddenCodexModel(request.model)) {
        throw new RoutingError("Model is not available", 400)
    }
    const config = loadRoutingConfig()
    if (isOfficialModel(request.model)) {
        const accountEntries = resolveAccountEntries(config, request.model)
        return createAccountCompletionWithEntries(request, accountEntries)
    }

    const flowEntries = resolveFlowEntries(config, request.model)
    return createFlowCompletionWithEntries(request, flowEntries)
}

async function* createFlowCompletionStreamWithEntries(request: RoutedRequest, entries: RoutingEntry[]): AsyncGenerator<string, void, unknown> {
    let lastError: Error | null = null

    for (const entry of entries) {
        try {
            if (entry.provider === "antigravity") {
                const accountId = entry.accountId === "auto" ? undefined : entry.accountId
                // Skip rate-limited antigravity accounts (check both accountManager and router-level)
                if (accountId && entries.length > 1) {
                    const isLimited = accountManager.isAccountRateLimited(accountId) || isRouterRateLimited("antigravity", accountId)
                    if (isLimited) continue
                }
                yield* createChatCompletionStreamWithOptions({ ...request, model: entry.modelId }, {
                    accountId,
                    allowRotation: accountId ? false : true,
                })
                return
            }

            if (authStore.isRateLimited(entry.provider, entry.accountId) && entries.length > 1) {
                continue
            }

            const account = authStore.getAccount(entry.provider, entry.accountId)
            if (!account) {
                continue
            }

            let completion
            if (entry.provider === "codex") {
                completion = await createCodexCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
            } else if (entry.provider === "copilot") {
                completion = await createCopilotCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
            }

            if (!completion) {
                throw new Error("Empty completion")
            }

            yield buildMessageStart(request.model)
            let blockIndex = 0
            for (const block of completion.contentBlocks) {
                if (block.type === "tool_use") {
                    yield buildContentBlockStart(blockIndex, "tool_use", { id: block.id!, name: block.name! })
                    const inputText = JSON.stringify(block.input || {})
                    yield buildInputJsonDelta(blockIndex, inputText)
                    yield buildContentBlockStop(blockIndex)
                    blockIndex++
                    continue
                }

                yield buildContentBlockStart(blockIndex, "text")
                yield buildTextDelta(blockIndex, block.text || "")
                yield buildContentBlockStop(blockIndex)
                blockIndex++
            }
            yield buildMessageDelta(completion.stopReason || "end_turn", completion.usage)
            yield buildMessageStop()
            return
        } catch (error) {
            lastError = error as Error
            if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
                continue
            }
            if (error instanceof UpstreamError && shouldFallbackOnUpstream(error)) {
                // 🆕 修复：标记 rate-limited（同时更新 accountManager 和 router 级别状态）
                if (entry.provider === "antigravity" && entry.accountId !== "auto") {
                    accountManager.markRateLimitedFromError(entry.accountId, error.status, error.body)
                    markRouterRateLimited("antigravity", entry.accountId, 60000)  // 🆕 Router 级别也标记
                } else if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, error.status, error.body, error.retryAfter)
                    markRouterRateLimited(entry.provider, entry.accountId, 60000)  // 🆕 Router 级别也标记
                }
                continue
            }
            if (isTransientTransportError(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
                }
                continue
            }
            throw error
        }
    }

    // 🆕 如果所有 entries 都被跳过（rate-limited），清除状态并重试第一个
    if (!lastError && entries.length > 0) {
        // 清除 router 级别的 rate-limit 状态
        for (const entry of entries) {
            routerRateLimits.delete(getRouterRateLimitKey(entry.provider, entry.accountId))
        }
        // 清除 accountManager 的 rate-limit 状态
        accountManager.clearAllRateLimits()

        // 重试第一个 entry
        const entry = entries[0]
        if (entry.provider === "antigravity") {
            const accountId = entry.accountId === "auto" ? undefined : entry.accountId
            yield* createChatCompletionStreamWithOptions({ ...request, model: entry.modelId }, {
                accountId,
                allowRotation: accountId ? false : true,
            })
            return
        }
    }

    if (lastError) {
        throw lastError
    }

    throw new RoutingError("No routing entries available", 400)
}

async function* createAccountCompletionStreamWithEntries(request: RoutedRequest, entries: AccountRoutingEntry[]): AsyncGenerator<string, void, unknown> {
    let lastError: Error | null = null

    for (const entry of entries) {
        try {
            if (entry.provider === "antigravity") {
                if (entry.accountId === "auto") {
                    throw new RoutingError(`Account routing entry for "${request.model}" cannot use auto without smart switch expansion`, 400)
                }
                const isLimited = accountManager.isAccountRateLimited(entry.accountId) || isRouterRateLimited("antigravity", entry.accountId)
                if (isLimited) continue
                yield* createChatCompletionStreamWithOptions({ ...request, model: request.model }, {
                    accountId: entry.accountId,
                    allowRotation: false,
                })
                return
            }

            if (authStore.isRateLimited(entry.provider, entry.accountId)) {
                continue
            }

            const account = authStore.getAccount(entry.provider, entry.accountId)
            if (!account) {
                continue
            }

            let completion
            if (entry.provider === "codex") {
                completion = await createCodexCompletion(account, request.model, request.messages, request.tools, request.maxTokens)
            } else if (entry.provider === "copilot") {
                completion = await createCopilotCompletion(account, request.model, request.messages, request.tools, request.maxTokens)
            }

            if (!completion) {
                throw new Error("Empty completion")
            }

            yield buildMessageStart(request.model)
            let blockIndex = 0
            for (const block of completion.contentBlocks) {
                if (block.type === "tool_use") {
                    yield buildContentBlockStart(blockIndex, "tool_use", { id: block.id!, name: block.name! })
                    const inputText = JSON.stringify(block.input || {})
                    yield buildInputJsonDelta(blockIndex, inputText)
                    yield buildContentBlockStop(blockIndex)
                    blockIndex++
                    continue
                }

                yield buildContentBlockStart(blockIndex, "text")
                yield buildTextDelta(blockIndex, block.text || "")
                yield buildContentBlockStop(blockIndex)
                blockIndex++
            }
            yield buildMessageDelta(completion.stopReason || "end_turn", completion.usage)
            yield buildMessageStop()
            return
        } catch (error) {
            lastError = error as Error
            if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
                continue
            }
            if (error instanceof UpstreamError && shouldFallbackOnUpstream(error)) {
                if (entry.provider === "antigravity") {
                    accountManager.markRateLimitedFromError(entry.accountId, error.status, error.body, error.retryAfter, request.model)
                    markRouterRateLimited("antigravity", entry.accountId, 60000)
                } else {
                    authStore.markRateLimited(entry.provider, entry.accountId, error.status, error.body, error.retryAfter)
                    markRouterRateLimited(entry.provider, entry.accountId, 60000)
                }
                continue
            }
            if (isTransientTransportError(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
                }
                continue
            }
            throw error
        }
    }

    if (lastError) {
        throw lastError
    }

    throw new RoutingError(`No account routing entries available for model "${request.model}"`, 400)
}

export async function* createRoutedCompletionStream(request: RoutedRequest): AsyncGenerator<string, void, unknown> {
    if (isHiddenCodexModel(request.model)) {
        throw new RoutingError("Model is not available", 400)
    }
    const config = loadRoutingConfig()

    if (isOfficialModel(request.model)) {
        const accountEntries = resolveAccountEntries(config, request.model)
        yield* createAccountCompletionStreamWithEntries(request, accountEntries)
        return
    }

    const flowEntries = resolveFlowEntries(config, request.model)
    yield* createFlowCompletionStreamWithEntries(request, flowEntries)
}
