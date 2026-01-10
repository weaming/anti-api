import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import consola from "consola"
import type { AuthProvider } from "~/services/auth/types"

export interface RoutingEntry {
    id: string
    provider: AuthProvider
    accountId: string
    modelId: string
    label: string
    accountLabel?: string
}

export interface RoutingConfig {
    version: number
    updatedAt: string
    entries: RoutingEntry[]
}

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "."
const ROUTING_FILE = join(HOME_DIR, ".anti-api", "routing.json")

function ensureDir(): void {
    const dir = join(HOME_DIR, ".anti-api")
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }
}

export function loadRoutingConfig(): RoutingConfig {
    try {
        if (!existsSync(ROUTING_FILE)) {
            return { version: 1, updatedAt: new Date().toISOString(), entries: [] }
        }
        const raw = JSON.parse(readFileSync(ROUTING_FILE, "utf-8")) as RoutingConfig
        if (!raw.entries) {
            return { version: 1, updatedAt: new Date().toISOString(), entries: [] }
        }
        return raw
    } catch (error) {
        consola.warn("Failed to load routing config:", error)
        return { version: 1, updatedAt: new Date().toISOString(), entries: [] }
    }
}

export function saveRoutingConfig(entries: RoutingEntry[]): RoutingConfig {
    ensureDir()
    const config: RoutingConfig = {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries,
    }
    writeFileSync(ROUTING_FILE, JSON.stringify(config, null, 2))
    return config
}
