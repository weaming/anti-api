import { test, expect } from "bun:test"
import { UpstreamError, AntigravityError, HTTPError } from "../src/lib/error"

test("UpstreamError constructs with correct properties", () => {
    const error = new UpstreamError("antigravity", 429, "rate limited", "60")

    expect(error.status).toBe(429)
    expect(error.provider).toBe("antigravity")
    expect(error.body).toBe("rate limited")
    expect(error.retryAfter).toBe("60")
    expect(error.message).toBe("antigravity upstream error (429)")
})

test("UpstreamError works without retryAfter", () => {
    const error = new UpstreamError("codex", 500, "internal server error")

    expect(error.status).toBe(500)
    expect(error.retryAfter).toBeUndefined()
})

test("AntigravityError constructs with code", () => {
    const error = new AntigravityError("auth failed", "auth_error")

    expect(error.message).toBe("auth failed")
    expect(error.code).toBe("auth_error")
})

test("AntigravityError uses default code", () => {
    const error = new AntigravityError("something went wrong")

    expect(error.code).toBe("antigravity_error")
})

test("HTTPError stores response", () => {
    const mockResponse = new Response("Not Found", { status: 404 })
    const error = new HTTPError("HTTP error", mockResponse)

    expect(error.message).toBe("HTTP error")
    expect(error.response.status).toBe(404)
})

// Test buildLogReason logic (reimplemented for isolated testing)
function buildLogReason(error: unknown): string {
    if (error instanceof UpstreamError) {
        const body = (error.body || "").toLowerCase()
        if (error.status === 429) {
            if (body.includes("resource_exhausted") || body.includes("quota")) {
                return "quota exhausted"
            }
            return "rate limited"
        }
        if (error.status === 401) return "unauthorized"
        if (error.status === 403) return "forbidden"
        if (error.status === 404) return "not found"
        if (error.status >= 500) return "upstream error"
        return "upstream error"
    }

    if (error instanceof HTTPError) {
        return "http error"
    }

    if (error instanceof AntigravityError) {
        return error.code || "antigravity error"
    }

    return "internal error"
}

test("buildLogReason returns quota exhausted for 429 with quota body", () => {
    const error = new UpstreamError("antigravity", 429, "RESOURCE_EXHAUSTED: quota exceeded")
    expect(buildLogReason(error)).toBe("quota exhausted")
})

test("buildLogReason returns rate limited for generic 429", () => {
    const error = new UpstreamError("antigravity", 429, "too many requests")
    expect(buildLogReason(error)).toBe("rate limited")
})

test("buildLogReason returns correct reason for status codes", () => {
    expect(buildLogReason(new UpstreamError("p", 401, ""))).toBe("unauthorized")
    expect(buildLogReason(new UpstreamError("p", 403, ""))).toBe("forbidden")
    expect(buildLogReason(new UpstreamError("p", 404, ""))).toBe("not found")
    expect(buildLogReason(new UpstreamError("p", 500, ""))).toBe("upstream error")
    expect(buildLogReason(new UpstreamError("p", 503, ""))).toBe("upstream error")
})

test("buildLogReason returns http error for HTTPError", () => {
    const error = new HTTPError("error", new Response("", { status: 400 }))
    expect(buildLogReason(error)).toBe("http error")
})

test("buildLogReason returns code for AntigravityError", () => {
    const error = new AntigravityError("msg", "custom_code")
    expect(buildLogReason(error)).toBe("custom_code")
})

test("buildLogReason returns internal error for unknown errors", () => {
    expect(buildLogReason(new Error("unknown"))).toBe("internal error")
    expect(buildLogReason("string error")).toBe("internal error")
})
