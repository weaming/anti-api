/**
 * Anti-API HTTP服务器
 */

import { Hono } from "hono"
import { cors } from "hono/cors"
import { readFileSync } from "fs"
import { join } from "path"
import consola from "consola"

import { messageRoutes } from "./routes/messages/route"
import { openaiRoutes } from "./routes/openai/route"
import { authRouter } from "./routes/auth/route"
import { routingRouter } from "./routes/routing/route"
import { logsRouter } from "./routes/logs/route"
import { AVAILABLE_MODELS } from "./lib/config"
import { getAggregatedQuota } from "./services/quota-aggregator"
import { initAuth, isAuthenticated } from "./services/antigravity/login"
import { accountManager } from "./services/antigravity/account-manager"
import { loadRoutingConfig } from "./services/routing/config"
import { loadSettings, saveSettings } from "./services/settings"
import { pingAccount } from "./services/ping"
import { summarizeUpstreamError, UpstreamError } from "./lib/error"
import { authStore } from "./services/auth/store"
import { getDiscoveredModels, initModelDiscovery, refreshDiscoveredModels } from "./services/model-discovery"

import { getRequestLogContext } from "./lib/logger"
import { initLogCapture, setLogCaptureEnabled } from "./lib/log-buffer"

export const server = new Hono()

initLogCapture()
setLogCaptureEnabled(loadSettings().captureLogs)
initModelDiscovery()
consola.level = 0

// 中间件 - 请求日志 (只记录重要请求)
server.use(async (c, next) => {
    await next()
    const status = c.res.status
    const reason = c.res.headers.get("X-Log-Reason") || undefined

    // Only log errors
    if (status >= 400) {
        const ctx = getRequestLogContext()
        if (ctx.model && ctx.provider) {
            const providerName = ctx.provider === "antigravity" ? "Antigravity" : ctx.provider
            const accountPart = ctx.account ? ` >> ${ctx.account}` : ""
            console.log(`${status}: from ${ctx.model} > ${providerName}${accountPart}`)
        } else {
            console.log(`${status}: ${reason || "error"}`)
        }
    }
    // All successful requests are silent (detailed 200 logs are handled elsewhere)
})
server.use(cors())

// 启动时自动加载已保存的认证
// 启动时 - 认证加载移至入口文件 (main.ts)
// initAuth()
// accountManager.load()

// 根路径 - 重定向到配额面板
server.get("/", (c) => c.redirect("/quota"))

// Auth 路由
server.route("/auth", authRouter)

// Routing 配置路由
server.route("/routing", routingRouter)

// Logs
server.route("/logs", logsRouter)

// Settings API - 获取设置
server.get("/settings", (c) => {
    return c.json(loadSettings())
})

// Settings API - 保存设置
server.post("/settings", async (c) => {
    const body = await c.req.json()
    const updated = saveSettings(body)
    setLogCaptureEnabled(updated.captureLogs)
    return c.json(updated)
})

// Usage Tracking API
import { getUsage, resetUsage } from "./services/usage-tracker"

server.get("/usage", (c) => {
    return c.json(getUsage())
})

server.post("/usage/reset", (c) => {
    resetUsage()
    return c.json({ success: true })
})

// OpenAI 兼容端点
server.route("/v1/chat/completions", openaiRoutes)

// Anthropic兼容端点
server.route("/v1/messages", messageRoutes)

// 同时支持 v1beta (某些 GUI 工具使用)
server.route("/v1beta/messages", messageRoutes)

// 无前缀版本 for GUI tools
server.route("/messages", messageRoutes)

// 模型列表处理函数 - 合并静态列表 + 动态发现的上游模型
const modelsHandler = (c: any) => {
    const now = new Date().toISOString()

    // 合并静态 AVAILABLE_MODELS 和动态发现的模型
    const staticModels = AVAILABLE_MODELS.map(m => ({
        id: m.id,
        name: m.name,
        owned_by: "antigravity",
        source: "static" as const,
    }))

    const discovered = getDiscoveredModels()
    const staticIds = new Set(staticModels.map(m => m.id))

    // 动态发现的新模型（不在静态列表中的）
    const dynamicModels = discovered
        .filter(m => !staticIds.has(m.id))
        .map(m => ({
            id: m.id,
            name: m.displayName,
            owned_by: "antigravity",
            source: "discovered" as const,
        }))

    const models = [...staticModels, ...dynamicModels]

    return c.json({
        object: "list",
        data: models.map(m => ({
            id: m.id,
            type: "model",           // Anthropic format
            object: "model",         // OpenAI format
            created_at: now,         // Anthropic format (RFC 3339)
            created: Date.now(),     // OpenAI format (unix timestamp)
            owned_by: m.owned_by || "antigravity",
            display_name: m.name || m.id,
            // 标识模型来源：static=预置, discovered=动态发现
            ...(m.source === "discovered" ? { _source: "discovered" } : {}),
        })),
        has_more: false,
        first_id: models[0]?.id,
        last_id: models[models.length - 1]?.id,
    })
}

// 模型列表端点
server.get("/v1/models", modelsHandler)
server.get("/v1beta/models", modelsHandler)
server.get("/models", modelsHandler)  // 无前缀版本 for GUI tools

// 配额面板 - HTML Dashboard
server.get("/quota", async (c) => {
    try {
        const htmlPath = join(process.cwd(), "public/quota.html")
        const html = readFileSync(htmlPath, "utf-8")
        return c.html(html)
    } catch (error) {
        return c.text("Quota dashboard not found", 404)
    }
})

// 接入指南 - HTML
server.get("/connect", async (c) => {
    try {
        const htmlPath = join(process.cwd(), "public/connect.html")
        const html = readFileSync(htmlPath, "utf-8")
        return c.html(html)
    } catch (error) {
        return c.text("Connect guide not found", 404)
    }
})

// 配额数据 - JSON API
server.get("/quota/json", async (c) => {
    try {
        const snapshot = await getAggregatedQuota()
        return c.json(snapshot)
    } catch (error) {
        return c.json({ error: "Failed to fetch quota" }, 500)
    }
})

// Ping model availability for a specific account
server.post("/accounts/ping", async (c) => {
    let body: { provider?: string; accountId?: string; modelId?: string } = {}
    try {
        body = await c.req.json()
    } catch {
        body = {}
    }

    const provider = (body.provider || "").toLowerCase()
    const accountId = body.accountId || ""
    const modelId = body.modelId

    if (!provider || !accountId) {
        return c.json({ success: false, error: "provider and accountId are required" }, 400)
    }
    if (provider !== "antigravity") {
        return c.json({ success: false, error: "Unsupported provider" }, 400)
    }

    try {
        const result = await pingAccount(provider as any, accountId, modelId)
        return c.json({
            success: true,
            provider,
            accountId,
            modelId: result.modelId,
            latencyMs: result.latencyMs,
        })
    } catch (error) {
        if (error instanceof UpstreamError) {
            const summary = summarizeUpstreamError(error)
            return c.json({
                success: false,
                provider,
                accountId,
                modelId: modelId || null,
                status: error.status,
                reason: summary.reason || null,
                error: summary.message,
            })
        }
        return c.json({
            success: false,
            provider,
            accountId,
            modelId: modelId || null,
            error: (error as Error).message,
        })
    }
})

// 删除账号 - API（同时清理 routing 配置）
server.delete("/accounts/:id", async (c) => {
    const accountId = c.req.param("id")

    // 先尝试从 accountManager 删除 (antigravity 内存管理)
    let success = accountManager.removeAccount(accountId)

    // 如果 accountManager 找不到，尝试直接从 authStore 删除
    // 这覆盖了 token 过期或通过其他方式添加的账号
    if (!success) {
        if (authStore.deleteAccount("antigravity", accountId)) {
            success = true
        }
    }

    if (success) {
        // 同时清理 routing 配置中的该账号
        try {
            const { loadRoutingConfig, saveRoutingConfig } = require("./services/routing/config")
            const config = loadRoutingConfig()

            // 清理 Account Routing
            if (config.accountRouting) {
                let removedCount = 0
                const cleanedAccountRouting = {
                    ...config.accountRouting,
                    routes: config.accountRouting.routes.map((route: any) => ({
                        ...route,
                        entries: route.entries.filter((entry: any) => {
                            if (entry.accountId === accountId) {
                                removedCount++
                                return false
                            }
                            return true
                        })
                    }))
                }

                if (removedCount > 0) {
                    // 只更新 accountRouting
                    saveRoutingConfig(cleanedAccountRouting)
                }
            }
        } catch (e) {
            console.error("Failed to cleanup routing config:", e)
        }
        return c.json({ success: true, message: `Account ${accountId} removed` })
    }
    return c.json({ success: false, error: "Account not found" }, 404)
})

// Embeddings 端点 - 占位（FlowDown 等客户端会请求）
server.post("/embeddings", (c) => c.json({
    error: { type: "not_supported", message: "Embeddings not supported" }
}, 501))
server.post("/v1/embeddings", (c) => c.json({
    error: { type: "not_supported", message: "Embeddings not supported" }
}, 501))

// Responses 端点 - 占位（OpenAI Responses API）
server.post("/responses", (c) => c.json({
    error: { type: "not_supported", message: "Responses API not supported" }
}, 501))
server.post("/v1/responses", (c) => c.json({
    error: { type: "not_supported", message: "Responses API not supported" }
}, 501))

// 健康检查
server.get("/health", (c) => c.json({
    status: "ok",
    authenticated: isAuthenticated(),
}))

// 🆕 断路器状态监控
server.get("/health/circuit-breakers", async (c) => {
    const { accountCircuitBreakers } = await import("./lib/circuit-breaker")
    const metrics = accountCircuitBreakers.getAllMetrics()
    
    const result: Record<string, any> = {}
    for (const [name, metric] of metrics) {
        result[name] = {
            state: metric.state,
            failureCount: metric.failureCount,
            successCount: metric.successCount,
            lastFailureTime: metric.lastFailureTime,
            lastSuccessTime: metric.lastSuccessTime,
            nextAttemptTime: metric.nextAttemptTime,
        }
    }
    
    return c.json({
        timestamp: new Date().toISOString(),
        circuitBreakers: result,
        summary: {
            total: metrics.size,
            open: Array.from(metrics.values()).filter(m => m.state === "open").length,
            halfOpen: Array.from(metrics.values()).filter(m => m.state === "half_open").length,
            closed: Array.from(metrics.values()).filter(m => m.state === "closed").length,
        }
    })
})

// 🆕 重置所有断路器
server.post("/health/circuit-breakers/reset", async (c) => {
    const { accountCircuitBreakers } = await import("./lib/circuit-breaker")
    accountCircuitBreakers.resetAll()
    return c.json({ success: true, message: "All circuit breakers reset" })
})
