import { test, expect, mock, describe, beforeEach } from "bun:test"
import { resolveRoutingEntries, RoutingError } from "~/services/routing/router"
import type { RoutingConfig } from "~/services/routing/config"

// Mocks
const mockGetOfficialModelProviders = mock((model) => {
    if (model === "official-model") return ["antigravity"]
    if (model === "multi-provider") return ["antigravity", "other"]
    return []
})
const mockHasAccount = mock((id) => id === "valid-account" || id === "acc1" || id === "acc2")
const mockListAccounts = mock(() => ["acc1", "acc2"])

// Mock imports
mock.module("~/services/routing/models", () => ({
    getOfficialModelProviders: mockGetOfficialModelProviders
}))

mock.module("~/services/antigravity/account-manager", () => ({
    accountManager: {
        hasAccount: mockHasAccount,
        listAccounts: mockListAccounts
    }
}))

describe("resolveRoutingEntries", () => {
    beforeEach(() => {
        mockGetOfficialModelProviders.mockClear()
        mockHasAccount.mockClear()
        mockListAccounts.mockClear()
    })

    test("throws if model is not official", () => {
        expect(() => resolveRoutingEntries({} as any, "unknown-model")).toThrow(RoutingError)
    })

    test("throws if no routing and smartSwitch disabled", () => {
        const config: RoutingConfig = {
            version: 1,
            updatedAt: "",
            accountRouting: {
                smartSwitch: false,
                routes: []
            }
        }
        expect(() => resolveRoutingEntries(config, "official-model")).toThrow(RoutingError)
    })

    test("auto-fills if no routing and smartSwitch enabled", () => {
        const config: RoutingConfig = {
            version: 1,
            updatedAt: "",
            accountRouting: {
                smartSwitch: true,
                routes: []
            }
        }
        // Should return auto entries for antigravity
        const entires = resolveRoutingEntries(config, "official-model")
        expect(entires.length).toBe(2)
        expect(entires[0].provider).toBe("antigravity")
        expect(entires[0].id).toContain("auto-antigravity")
    })

    test("expands 'auto' accountId", () => {
        const config: RoutingConfig = {
            version: 1,
            updatedAt: "",
            accountRouting: {
                smartSwitch: true,
                routes: [{
                    id: "r1",
                    modelId: "official-model",
                    entries: [{
                        id: "e1",
                        provider: "antigravity",
                        accountId: "auto",
                        modelId: ""
                    }]
                }]
            }
        }
        const entries = resolveRoutingEntries(config, "official-model")
        expect(entries.length).toBe(2)
        expect(entries[0].accountId).not.toBe("auto")
    })

    test("filters unavailable accounts", () => {
        const config: RoutingConfig = {
            version: 1,
            updatedAt: "",
            accountRouting: {
                smartSwitch: false,
                routes: [{
                    id: "r1",
                    modelId: "official-model",
                    entries: [
                        { id: "e1", provider: "antigravity", accountId: "valid-account", modelId: "" },
                        { id: "e2", provider: "antigravity", accountId: "invalid-account", modelId: "" }
                    ]
                }]
            }
        }
        const entries = resolveRoutingEntries(config, "official-model")
        expect(entries.length).toBe(1)
        expect(entries[0].accountId).toBe("valid-account")
    })

    test("falls back to auto if all configured fail and smartSwitch enabled", () => {
        const config: RoutingConfig = {
            version: 1,
            updatedAt: "",
            accountRouting: {
                smartSwitch: true,
                routes: [{
                    id: "r1",
                    modelId: "official-model",
                    entries: [
                        { id: "e1", provider: "antigravity", accountId: "invalid-account", modelId: "" }
                    ]
                }]
            }
        }
        // Should fallback to auto entries (which come from listAccounts -> acc1, acc2)
        // Check mockListAccounts
        const entries = resolveRoutingEntries(config, "official-model")
        expect(entries.length).toBe(2)
    })
})
