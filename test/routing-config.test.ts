import { test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

function withTempHome(): { dir: string; prevHome: string | undefined; prevProfile: string | undefined } {
    const dir = mkdtempSync(join(tmpdir(), "anti-api-test-"))
    const prevHome = process.env.HOME
    const prevProfile = process.env.USERPROFILE
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    return { dir, prevHome, prevProfile }
}

function restoreEnv(prevHome: string | undefined, prevProfile: string | undefined) {
    if (prevHome === undefined) {
        delete process.env.HOME
    } else {
        process.env.HOME = prevHome
    }
    if (prevProfile === undefined) {
        delete process.env.USERPROFILE
    } else {
        process.env.USERPROFILE = prevProfile
    }
}

test("routing config saves and loads entries", async () => {
    const { dir, prevHome, prevProfile } = withTempHome()
    const { saveRoutingConfig, loadRoutingConfig } = await import(`../src/services/routing/config.ts?${Date.now()}`)

    saveRoutingConfig([
        {
            id: "route-1",
            provider: "antigravity",
            accountId: "acc-1",
            modelId: "claude-opus-4-5-thinking",
            label: "Opus A1",
            accountLabel: "Account A",
        },
    ])

    const loaded = loadRoutingConfig()
    expect(loaded.entries.length).toBe(1)
    expect(loaded.entries[0].label).toBe("Opus A1")

    rmSync(dir, { recursive: true, force: true })
    restoreEnv(prevHome, prevProfile)
})

test("routing models include antigravity defaults", async () => {
    const { dir, prevHome, prevProfile } = withTempHome()
    const { getProviderModels } = await import(`../src/services/routing/models.ts?${Date.now()}`)

    const models = getProviderModels("antigravity")
    expect(models.length).toBeGreaterThan(0)

    rmSync(dir, { recursive: true, force: true })
    restoreEnv(prevHome, prevProfile)
})
