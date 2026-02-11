import { Hono } from "hono"
import { authStore } from "~/services/auth/store"
import { getProviderModels } from "~/services/routing/models"
import { loadRoutingConfig, saveRoutingConfig, type RoutingEntry, type AccountRoutingConfig } from "~/services/routing/config"
import { accountManager } from "~/services/antigravity/account-manager"
import { getAggregatedQuota } from "~/services/quota-aggregator"
import { readFileSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import type { ProviderAccountSummary } from "~/services/auth/types"

export const routingRouter = new Hono()

routingRouter.get("/", (c) => {
    try {
        const htmlPath = join(process.cwd(), "public/routing.html")
        const html = readFileSync(htmlPath, "utf-8")
        return c.html(html)
    } catch {
        return c.text("Routing panel not found", 404)
    }
})

routingRouter.get("/config", async (c) => {
    accountManager.load()
    const config = loadRoutingConfig()

    const listSummariesInOrder = (provider: "antigravity"): ProviderAccountSummary[] => {
        const accounts = authStore.listAccounts(provider)
        const sorted = accounts.sort((a, b) => {
            const aTime = a.createdAt || ""
            const bTime = b.createdAt || ""
            return (aTime && bTime) ? aTime.localeCompare(bTime) : (aTime ? -1 : (bTime ? 1 : 0))
        })
        return sorted.map(acc => ({
            id: acc.id,
            provider: acc.provider,
            displayName: acc.label || acc.email || acc.login || acc.id,
            email: acc.email,
            login: acc.login,
            label: acc.label,
            expiresAt: acc.expiresAt,
        }))
    }

    const accounts = {
        antigravity: listSummariesInOrder("antigravity"),
    }

    const models = {
        antigravity: getProviderModels("antigravity"),
    }

    // Get quota data for displaying on model blocks
    let quota: Awaited<ReturnType<typeof getAggregatedQuota>> | null = null
    try {
        quota = await getAggregatedQuota()
    } catch {
        // Quota fetch is optional, continue without it
    }

    return c.json({ config, accounts, models, quota })
})

routingRouter.post("/config", async (c) => {
    const body = await c.req.json<{ accountRouting?: AccountRoutingConfig }>()

    let accountRouting: AccountRoutingConfig | undefined
    if (body.accountRouting) {
        accountRouting = {
            smartSwitch: body.accountRouting.smartSwitch ?? false,
            routes: Array.isArray(body.accountRouting.routes)
                ? body.accountRouting.routes.map(route => ({
                    id: route.id || randomUUID(),
                    modelId: (route.modelId || "").trim(),
                    entries: Array.isArray(route.entries)
                        ? route.entries.map(entry => ({
                            ...entry,
                            id: entry.id || randomUUID(),
                            provider: entry.provider,
                        }))
                        : [],
                }))
                : [],
        }
    }

    const config = saveRoutingConfig(accountRouting)
    return c.json({ success: true, config })
})

// 🆕 清理孤立账号（已删除但仍在 routing 中的账号）
routingRouter.post("/cleanup", async (c) => {
    const config = loadRoutingConfig()

    // 获取所有有效账号
    const validAntigravity = new Set(authStore.listSummaries("antigravity").map(a => a.id || a.email))

    // 扩展点：如果支持其他 Provider，在这里添加验证清单

    let removedCount = 0

    // 清理 account routing 中的孤立 entries
    const cleanedAccountRouting = config.accountRouting ? {
        ...config.accountRouting,
        routes: config.accountRouting.routes.map(route => ({
            ...route,
            entries: route.entries.filter(entry => {
                let isValid = false
                if (entry.provider === "antigravity") {
                    isValid = entry.accountId === "auto" || validAntigravity.has(entry.accountId)
                }
                // else if (entry.provider === "other") { ... }

                if (!isValid) {
                    removedCount++
                }
                return isValid
            })
        }))
    } : config.accountRouting

    // 保存清理后的配置
    const newConfig = saveRoutingConfig(cleanedAccountRouting)

    // 同时清理 account-manager 的 rate limit 状态
    accountManager.clearAllRateLimits()

    return c.json({
        success: true,
        removedCount,
        config: newConfig
    })
})
