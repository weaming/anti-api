import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import consola from "consola"
import type { AuthProvider } from "~/services/auth/types"
import { getDataDir } from "~/lib/data-dir"

export interface RoutingEntry {
    id: string
    provider: AuthProvider
    accountId: string
    modelId: string
    label: string
    accountLabel?: string
}

export interface AccountRoutingEntry {
    id: string
    provider: AuthProvider
    accountId: string
    label?: string
    accountLabel?: string
}

export interface AccountRoutingRoute {
    id: string
    modelId: string
    entries: AccountRoutingEntry[]
}

export interface AccountRoutingConfig {
    smartSwitch: boolean
    routes: AccountRoutingRoute[]
}

export interface RoutingConfig {
    version: number
    updatedAt: string
    accountRouting?: AccountRoutingConfig
}

const ROUTING_FILE = join(getDataDir(), "routing.json")
const CURRENT_VERSION = 3

function ensureDir(): void {
    const dir = getDataDir()
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }
}

function normalizeAccountEntry(entry: AccountRoutingEntry): AccountRoutingEntry {
    return {
        ...entry,
        id: entry.id || randomUUID(),
    }
}

function normalizeAccountRoute(route: Partial<AccountRoutingRoute>, index: number): AccountRoutingRoute | null {
    const modelId = (route.modelId || "").trim()
    if (!modelId) return null

    const entries = Array.isArray(route.entries) ? route.entries.map(normalizeAccountEntry) : []

    return {
        id: route.id || randomUUID(),
        modelId,
        entries,
    }
}

function normalizeConfig(raw: Partial<RoutingConfig> & { flows?: any[], entries?: any[] }): RoutingConfig {
    const updatedAt = raw.updatedAt || new Date().toISOString()
    const accountRouting: AccountRoutingConfig = {
        smartSwitch: raw.accountRouting?.smartSwitch ?? true,
        routes: Array.isArray(raw.accountRouting?.routes)
            ? raw.accountRouting!.routes
                .map((route, index) => normalizeAccountRoute(route, index))
                .filter((route): route is AccountRoutingRoute => !!route)
            : [],
    }

    return {
        version: raw.version || CURRENT_VERSION,
        updatedAt,
        accountRouting,
    }
}

export function loadRoutingConfig(): RoutingConfig {
    try {
        if (!existsSync(ROUTING_FILE)) {
            return { version: CURRENT_VERSION, updatedAt: new Date().toISOString(), accountRouting: { smartSwitch: true, routes: [] } }
        }
        const raw = JSON.parse(readFileSync(ROUTING_FILE, "utf-8"))
        return normalizeConfig(raw)
    } catch (error) {
        consola.warn("Failed to load routing config:", error)
        return { version: CURRENT_VERSION, updatedAt: new Date().toISOString(), accountRouting: { smartSwitch: true, routes: [] } }
    }
}

export function saveRoutingConfig(
    accountRouting?: AccountRoutingConfig
): RoutingConfig {
    ensureDir()
    const existing = loadRoutingConfig()
    const config: RoutingConfig = {
        version: CURRENT_VERSION,
        updatedAt: new Date().toISOString(),
        accountRouting: accountRouting !== undefined ? accountRouting : existing.accountRouting,
    }
    writeFileSync(ROUTING_FILE, JSON.stringify(config, null, 2))
    return config
}
