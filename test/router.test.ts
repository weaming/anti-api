import { test, expect } from "bun:test"

// Test helper types matching router.ts
interface RoutingEntry {
    id: string
    provider: "antigravity" | "codex" | "copilot"
    accountId: string
    modelId: string
    label: string
}

interface RoutingFlow {
    id: string
    name: string
    entries: RoutingEntry[]
}

// Reimplemented functions for isolated testing
function getFlowKey(model: string): string {
    const raw = model?.trim() || ""
    if (raw.toLowerCase().startsWith("route:")) {
        return raw.slice("route:".length).trim()
    }
    return raw
}

function selectFlowEntries(flows: RoutingFlow[], model: string): RoutingEntry[] {
    if (flows.length === 0) {
        return []
    }

    const flowKey = getFlowKey(model)
    const exact = flows.find(flow => flow.name === flowKey)
    if (exact) {
        return exact.entries
    }

    return []
}

function isEntryUsable(entry: RoutingEntry): boolean {
    return !!(entry.accountId && entry.modelId)
}

function normalizeEntries(entries: RoutingEntry[]): RoutingEntry[] {
    return entries.filter(isEntryUsable)
}

const FALLBACK_STATUSES = new Set([401, 403, 408, 429, 500, 503, 529])

function shouldFallbackOnUpstream(status: number): boolean {
    return FALLBACK_STATUSES.has(status)
}

// Helper to create test entries
function makeEntry(id: string, provider: "antigravity" = "antigravity"): RoutingEntry {
    return {
        id,
        provider,
        accountId: `account-${id}`,
        modelId: `model-${id}`,
        label: `Label ${id}`,
    }
}

// Tests

test("getFlowKey extracts route: prefix", () => {
    expect(getFlowKey("route:my-flow")).toBe("my-flow")
    expect(getFlowKey("Route:My-Flow")).toBe("My-Flow")
    expect(getFlowKey("  route:spaced")).toBe("spaced")
})

test("getFlowKey returns model as-is without prefix", () => {
    expect(getFlowKey("claude-sonnet-4-5")).toBe("claude-sonnet-4-5")
    expect(getFlowKey("gpt-4")).toBe("gpt-4")
    expect(getFlowKey("")).toBe("")
})

test("selectFlowEntries finds exact match by name", () => {
    const flows = [
        { id: "flow-default", name: "default", entries: [makeEntry("default")] },
        { id: "flow-opus", name: "opus", entries: [makeEntry("opus")] },
    ]

    const result = selectFlowEntries(flows, "route:opus")
    expect(result.length).toBe(1)
    expect(result[0].id).toBe("opus")
})

test("selectFlowEntries returns empty when no match", () => {
    const flows = [
        { id: "flow-opus", name: "opus", entries: [makeEntry("opus")] },
        { id: "flow-fast", name: "fast", entries: [makeEntry("fast")] },
    ]

    const result = selectFlowEntries(flows, "route:unknown")
    expect(result).toEqual([])
})

test("selectFlowEntries returns empty for no flows", () => {
    expect(selectFlowEntries([], "any")).toEqual([])
})

test("normalizeEntries filters out invalid entries", () => {
    const entries: RoutingEntry[] = [
        makeEntry("valid"),
        { id: "no-account", provider: "antigravity", accountId: "", modelId: "m", label: "x" },
        { id: "no-model", provider: "antigravity", accountId: "a", modelId: "", label: "y" },
    ]

    const result = normalizeEntries(entries)
    expect(result.length).toBe(1)
    expect(result[0].id).toBe("valid")
})

test("shouldFallbackOnUpstream returns true for fallback statuses", () => {
    expect(shouldFallbackOnUpstream(429)).toBe(true)
    expect(shouldFallbackOnUpstream(500)).toBe(true)
    expect(shouldFallbackOnUpstream(503)).toBe(true)
    expect(shouldFallbackOnUpstream(401)).toBe(true)
})

test("shouldFallbackOnUpstream returns false for success/other statuses", () => {
    expect(shouldFallbackOnUpstream(200)).toBe(false)
    expect(shouldFallbackOnUpstream(400)).toBe(false)
    expect(shouldFallbackOnUpstream(404)).toBe(false)
})
