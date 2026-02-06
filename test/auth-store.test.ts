import { test, expect, mock, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync, readFileSync } from "fs"

// Mock dependencies
const TEST_DATA_DIR = join(process.cwd(), ".test-data-auth-store-" + Date.now())
const TEST_AUTH_DIR = join(TEST_DATA_DIR, "auth")

mock.module("~/lib/data-dir", () => ({
    getDataDir: () => TEST_DATA_DIR,
    ensureDataDir: () => {
        if (!existsSync(TEST_DATA_DIR)) {
            mkdirSync(TEST_DATA_DIR, { recursive: true })
        }
        return TEST_DATA_DIR
    }
}))

describe("authStore", async () => {
    // Dynamically import to ensure mocks apply
    const { authStore } = await import("~/services/auth/store")

    beforeEach(() => {
        if (existsSync(TEST_DATA_DIR)) {
            rmSync(TEST_DATA_DIR, { recursive: true, force: true })
        }
        mkdirSync(TEST_AUTH_DIR, { recursive: true })
    })

    afterEach(() => {
        if (existsSync(TEST_DATA_DIR)) {
            rmSync(TEST_DATA_DIR, { recursive: true, force: true })
        }
    })

    test("saves and lists accounts", () => {
        authStore.saveAccount({
            id: "acc-1",
            provider: "antigravity",
            email: "test@example.com",
            accessToken: "tok",
            createdAt: new Date().toISOString()
        })

        const accounts = authStore.listAccounts("antigravity")
        expect(accounts.length).toBe(1)
        expect(accounts[0].id).toBe("acc-1")
    })

    test("rate limit logic", () => {
        const delay = authStore.markRateLimited("antigravity", "acc-2", 429, "msg", "5")
        expect(delay).toBeGreaterThan(0)
        expect(authStore.isRateLimited("antigravity", "acc-2")).toBe(true)

        authStore.markSuccess("antigravity", "acc-2")
        expect(authStore.isRateLimited("antigravity", "acc-2")).toBe(false)
    })
})

import { rmSync } from "fs"
import * as path from "path"
