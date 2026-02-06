import { test, expect } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
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

test("routing models include antigravity defaults", async () => {
    const { dir, prevHome, prevProfile } = withTempHome()
    const { getProviderModels } = await import(`../src/services/routing/models.ts?${Date.now()}`)

    const models = getProviderModels("antigravity")
    expect(models.length).toBeGreaterThan(0)

    rmSync(dir, { recursive: true, force: true })
    restoreEnv(prevHome, prevProfile)
})

test("routing config saves and loads account routing", async () => {
    const { dir, prevHome, prevProfile } = withTempHome()
    const { saveRoutingConfig, loadRoutingConfig } = await import(`../src/services/routing/config.ts?${Date.now()}`)

    const config = saveRoutingConfig(
        {
            smartSwitch: true,
            routes: [
                {
                    id: "route-a",
                    modelId: "claude-sonnet-4-5",
                    entries: [
                        {
                            id: "entry-a",
                            provider: "antigravity",
                            accountId: "acc-1",
                            accountLabel: "Account A",
                        },
                    ],
                },
            ],
        }
    )

    const loaded = loadRoutingConfig()
    expect(loaded.accountRouting?.smartSwitch).toBe(true)
    expect(loaded.accountRouting?.routes[0].modelId).toBe("claude-sonnet-4-5")
    expect(loaded.accountRouting?.routes[0].entries[0].accountId).toBe("acc-1")

    rmSync(dir, { recursive: true, force: true })
    restoreEnv(prevHome, prevProfile)
})
