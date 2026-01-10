import { Hono } from "hono"
import { authStore } from "~/services/auth/store"
import { getProviderModels } from "~/services/routing/models"
import { loadRoutingConfig, saveRoutingConfig, type RoutingEntry } from "~/services/routing/config"
import { accountManager } from "~/services/antigravity/account-manager"
import { readFileSync } from "fs"
import { join } from "path"

export const routingRouter = new Hono()

routingRouter.get("/", (c) => {
    try {
        const htmlPath = join(import.meta.dir, "../../../public/routing.html")
        const html = readFileSync(htmlPath, "utf-8")
        return c.html(html)
    } catch {
        return c.text("Routing panel not found", 404)
    }
})

routingRouter.get("/config", (c) => {
    accountManager.load()
    const config = loadRoutingConfig()
    const accounts = {
        antigravity: authStore.listSummaries("antigravity"),
        codex: authStore.listSummaries("codex"),
        copilot: authStore.listSummaries("copilot"),
    }

    const models = {
        antigravity: getProviderModels("antigravity"),
        codex: getProviderModels("codex"),
        copilot: getProviderModels("copilot"),
    }

    return c.json({ config, accounts, models })
})

routingRouter.post("/config", async (c) => {
    const body = await c.req.json<{ entries?: RoutingEntry[] }>()
    const entries = Array.isArray(body.entries) ? body.entries : []
    const normalized = entries.map(entry => ({
        ...entry,
        id: entry.id || crypto.randomUUID(),
        label: entry.label || `${entry.provider}:${entry.modelId}`,
    }))

    const config = saveRoutingConfig(normalized)
    return c.json({ success: true, config })
})
