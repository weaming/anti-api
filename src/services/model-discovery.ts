/**
 * 动态模型发现服务
 * 从上游 fetchAvailableModels API 获取实际可用模型列表，并缓存结果
 * 解决硬编码模型列表无法跟随上游更新的问题
 */

import consola from "consola"
import { authStore } from "~/services/auth/store"
import { accountManager } from "~/services/antigravity/account-manager"
import { refreshAccessToken } from "~/services/antigravity/oauth"
import { fetchAntigravityModels } from "~/services/antigravity/quota-fetch"
import type { ProviderAccount } from "~/services/auth/types"

export interface DiscoveredModel {
    /** 上游返回的原始模型 ID */
    id: string
    /** 人类可读的显示名（从映射表或 ID 推导） */
    displayName: string
    /** 来源提供商 */
    provider: "antigravity"
    /** 发现时间 */
    discoveredAt: string
}

/** 已知模型 ID → 友好显示名映射 */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
    // Claude 系列
    "claude-sonnet-4-5": "Claude Sonnet 4.5",
    "claude-sonnet-4-5-thinking": "Claude Sonnet 4.5 (Thinking)",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
    "claude-opus-4-5-thinking": "Claude Opus 4.5 (Thinking)",
    "claude-opus-4-6-thinking": "Claude Opus 4.6 (Thinking)",
    // Gemini 3 系列（仅保留已验证可用的模型）  
    "gemini-3-pro-image": "Gemini 3 Pro (Image)",
    "gemini-3-flash": "Gemini 3 Flash",
    // Gemini 3.1 系列
    "gemini-3.1-pro-high": "Gemini 3.1 Pro (High)",
    "gemini-3.1-pro-low": "Gemini 3.1 Pro (Low)",
    // GPT 系列
    "gpt-oss-120b-medium": "GPT-OSS 120B (Medium)",
}

/** 需要过滤排除的模型前缀（内部/平板/实验性模型） */
const MODEL_EXCLUDE_PREFIXES = [
    "tab_",      // 平板专用预览模型
    "chat_",     // 内部聊天模型
]

/**
 * 是否使用上游原始模型名称
 * 设为 true 时，/v1/models 返回的 display_name 将使用上游原始 ID
 * 设为 false 时，使用我们定义的友好显示名
 */
const USE_ORIGINAL_MODEL_NAMES = true

/** 缓存的动态模型列表 */
let discoveredModels: DiscoveredModel[] = []
/** 缓存刷新时间 */
let lastRefreshAt = 0
/** 缓存有效期 (5 分钟) */
const CACHE_TTL_MS = 5 * 60 * 1000
/** 最小刷新间隔 (30 秒，防抖) */
const MIN_REFRESH_INTERVAL_MS = 30 * 1000
/** 是否正在刷新 */
let refreshing = false

/**
 * 检查模型是否应该被过滤排除
 */
function shouldExcludeModel(modelId: string): boolean {
    const lowerId = modelId.toLowerCase()
    return MODEL_EXCLUDE_PREFIXES.some(prefix => lowerId.startsWith(prefix))
}

/**
 * 根据模型 ID 生成友好显示名
 */
function resolveDisplayName(modelId: string): string {
    // 如果配置为使用上游原始名称，直接返回原始 ID
    if (USE_ORIGINAL_MODEL_NAMES) {
        return modelId
    }

    if (MODEL_DISPLAY_NAMES[modelId]) {
        return MODEL_DISPLAY_NAMES[modelId]
    }
    // 自动生成：将 kebab-case 转为 Title Case
    return modelId
        .split("-")
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ")
}

/**
 * 刷新 token（如果需要）
 */
async function ensureValidToken(account: ProviderAccount): Promise<ProviderAccount> {
    if (!account.refreshToken) return account
    if (!account.expiresAt || account.expiresAt > Date.now() + 60_000) return account

    try {
        const refreshed = await refreshAccessToken(account.refreshToken)
        const updated = {
            ...account,
            accessToken: refreshed.accessToken,
            expiresAt: Date.now() + refreshed.expiresIn * 1000,
        }
        authStore.saveAccount(updated)
        return updated
    } catch {
        return account
    }
}

/**
 * 从所有账号聚合模型列表
 */
async function fetchAllUpstreamModels(): Promise<Set<string>> {
    const accounts = authStore.listAccounts("antigravity")
    if (accounts.length === 0) return new Set()

    const allModelIds = new Set<string>()

    // 并行查询所有账号，取并集
    const results = await Promise.allSettled(
        accounts.map(async (account) => {
            const refreshed = await ensureValidToken(account)
            const result = await fetchAntigravityModels(refreshed.accessToken, refreshed.projectId)
            return Object.keys(result.models || {})
        })
    )

    for (const result of results) {
        if (result.status === "fulfilled") {
            for (const modelId of result.value) {
                allModelIds.add(modelId)
            }
        }
    }

    return allModelIds
}

/**
 * 执行模型列表刷新
 */
async function doRefresh(): Promise<void> {
    if (refreshing) return
    refreshing = true

    try {
        const upstreamModelIds = await fetchAllUpstreamModels()

        if (upstreamModelIds.size > 0) {
            const now = new Date().toISOString()
            // 过滤掉不需要展示的模型
            const filtered = Array.from(upstreamModelIds).filter(id => !shouldExcludeModel(id))
            discoveredModels = filtered.map(id => ({
                id,
                displayName: resolveDisplayName(id),
                provider: "antigravity",
                discoveredAt: now,
            }))
            lastRefreshAt = Date.now()
            consola.info(`[ModelDiscovery] 发现 ${discoveredModels.length} 个上游模型: ${discoveredModels.map(m => m.id).join(", ")}`)
        } else {
            consola.debug("[ModelDiscovery] 上游未返回模型，保留缓存")
        }
    } catch (error) {
        consola.warn("[ModelDiscovery] 刷新失败:", error)
    } finally {
        refreshing = false
    }
}

/**
 * 获取已发现的动态模型列表
 * 如果缓存过期会自动触发后台刷新
 */
export function getDiscoveredModels(): DiscoveredModel[] {
    const now = Date.now()

    // 缓存过期或从未刷新：触发后台刷新
    if (now - lastRefreshAt > CACHE_TTL_MS && now - lastRefreshAt > MIN_REFRESH_INTERVAL_MS) {
        doRefresh().catch(() => {})
    }

    return discoveredModels
}

/**
 * 强制刷新模型列表（等待完成）
 */
export async function refreshDiscoveredModels(): Promise<DiscoveredModel[]> {
    await doRefresh()
    return discoveredModels
}

/**
 * 检查某个模型 ID 是否在动态发现的列表中
 */
export function isDiscoveredModel(modelId: string): boolean {
    return discoveredModels.some(m => m.id === modelId)
}

/**
 * 获取所有已知模型 ID（静态 + 动态）
 */
export function getAllKnownModelIds(): string[] {
    const staticIds = Object.keys(MODEL_DISPLAY_NAMES)
    const dynamicIds = discoveredModels.map(m => m.id)
    return Array.from(new Set([...staticIds, ...dynamicIds]))
}

/**
 * 检查模型是否应该被过滤排除（用于测试）
 */
export { shouldExcludeModel, resolveDisplayName }

/**
 * 初始化：启动时立即刷新一次
 */
export function initModelDiscovery(): void {
    // 延迟 3 秒执行首次刷新，等待 authStore 加载完成
    setTimeout(() => {
        doRefresh().catch(() => {})
    }, 3000)
}
