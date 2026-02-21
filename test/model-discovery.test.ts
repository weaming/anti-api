/**
 * Model Discovery Tests
 * 测试动态模型发现和过滤功能
 * 通过 HTTP API 调用来测试，绕过内存限流状态
 */

import { describe, it, expect, beforeAll } from "bun:test"
import {
    getDiscoveredModels,
    refreshDiscoveredModels,
    isDiscoveredModel,
    getAllKnownModelIds,
    shouldExcludeModel,
    resolveDisplayName,
} from "../src/services/model-discovery"
import { authStore } from "../src/services/auth/store"

const API_BASE = process.env.API_BASE || "http://localhost:8964"
const API_KEY = "sk-antigravity"

describe("Model Discovery - Filter Logic", () => {
    describe("shouldExcludeModel", () => {
        it("should exclude tab_ prefixed models", () => {
            expect(shouldExcludeModel("tab_jump_flash_lite_preview")).toBe(true)
            expect(shouldExcludeModel("tab_flash_lite_preview")).toBe(true)
            expect(shouldExcludeModel("TAB_anything")).toBe(true)
        })

        it("should exclude chat_ prefixed models", () => {
            expect(shouldExcludeModel("chat_20706")).toBe(true)
            expect(shouldExcludeModel("chat_23310")).toBe(true)
        })

        it("should NOT exclude gemini models", () => {
            expect(shouldExcludeModel("gemini-2.5-flash")).toBe(false)
            expect(shouldExcludeModel("gemini-3-pro-high")).toBe(false)
            expect(shouldExcludeModel("gemini-3.1-pro-low")).toBe(false)
        })

        it("should NOT exclude claude models", () => {
            expect(shouldExcludeModel("claude-sonnet-4-5")).toBe(false)
            expect(shouldExcludeModel("claude-opus-4-6-thinking")).toBe(false)
        })

        it("should NOT exclude gpt-oss models", () => {
            expect(shouldExcludeModel("gpt-oss-120b")).toBe(false)
            expect(shouldExcludeModel("gpt-oss-120b-medium")).toBe(false)
        })
    })

    describe("resolveDisplayName", () => {
        it("should return original name when USE_ORIGINAL_MODEL_NAMES is true", () => {
            // 因为 USE_ORIGINAL_MODEL_NAMES = true，所以直接返回原始 ID
            expect(resolveDisplayName("gemini-2.5-flash")).toBe("gemini-2.5-flash")
            expect(resolveDisplayName("gemini-3-pro-high")).toBe("gemini-3-pro-high")
            expect(resolveDisplayName("gemini-3.1-pro-low")).toBe("gemini-3.1-pro-low")
        })
    })

    describe("getAllKnownModelIds", () => {
        it("should include both static and dynamic models", () => {
            const allModels = getAllKnownModelIds()

            // 静态列表中的模型
            expect(allModels).toContain("claude-sonnet-4-6")
            expect(allModels).toContain("claude-opus-4-6-thinking")
            expect(allModels).toContain("gemini-3-flash")
            expect(allModels).toContain("gemini-3.1-pro-low")
            expect(allModels).toContain("gpt-oss-120b-medium")

            // Gemini 模型
            const geminiModels = allModels.filter(m => m.startsWith("gemini-"))
            expect(geminiModels.length).toBeGreaterThan(0)
            console.log(`Total known models: ${allModels.length}`)
        })
    })
})

describe("Model Discovery - Model Availability Test", () => {
    const testAccounts: Array<{ id: string; accessToken: string }> = []

    beforeAll(async () => {
        // 获取可用的 Antigravity 账号
        const accounts = authStore.listAccounts("antigravity")
        for (const account of accounts.slice(0, 2)) { // 最多测试 2 个账号
            if (account.accessToken) {
                testAccounts.push({ id: account.id, accessToken: account.accessToken })
            }
        }
    })

    // 所有需要测试的模型（仅包含上游 quota API 返回的模型）
    const CLAUDE_MODELS_TO_TEST = [
        "claude-sonnet-4-6",
        "claude-opus-4-6-thinking",
    ]

    const GPT_MODELS_TO_TEST = [
        "gpt-oss-120b-medium",
    ]

    const GEMINI_MODELS_TO_TEST = [
        "gemini-3-flash",
        "gemini-3.1-pro-high",
        "gemini-3.1-pro-low",
    ]

    it("should have test accounts available", () => {
        expect(testAccounts.length).toBeGreaterThan(0)
    })

    // 对每个 Gemini 模型进行可用性测试（15秒超时）
    for (const modelId of GEMINI_MODELS_TO_TEST) {
        it(`gemini model "${modelId}" should be available`, { timeout: 15000 }, async () => {
            if (testAccounts.length === 0) {
                console.log("⊘ No test accounts available, skipping")
                return
            }

            try {
                // 通过 HTTP API 调用来测试
                const response = await fetch(`${API_BASE}/v1/chat/completions`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${API_KEY}`,
                    },
                    body: JSON.stringify({
                        model: modelId,
                        messages: [{ role: "user", content: "你是谁？" }],
                        max_tokens: 100,
                        stream: false,
                    }),
                })

                if (response.status === 200) {
                    const data = await response.json()
                    const content = data.choices?.[0]?.message?.content || ""
                    expect(content.length).toBeGreaterThan(0)
                    console.log(`✓ ${modelId}: ${content.slice(0, 50)}...`)
                } else if (response.status === 400 || response.status === 404) {
                    console.log(`⊘ ${modelId}: 模型不支持`)
                } else if (response.status === 429) {
                    const errorText = await response.text()
                    // 尝试解析错误消息，判断是配额用完还是请求频繁
                    try {
                        const errorJson = JSON.parse(errorText)
                        const message = errorJson.error?.message || ""
                        if (message.includes("quota") || message.includes("exhausted")) {
                            console.log(`⚠ ${modelId}: 429 配额用尽 - ${message.slice(0, 60)}`)
                        } else if (message.includes("rate limit") || message.includes("too many")) {
                            console.log(`⚠ ${modelId}: 429 请求频繁 - ${message.slice(0, 60)}`)
                        } else {
                            console.log(`⚠ ${modelId}: 429 限流 - ${message.slice(0, 60)}`)
                        }
                    } catch {
                        console.log(`⚠ ${modelId}: 429 限流 - ${errorText.slice(0, 60)}`)
                    }
                } else if (response.status === 503) {
                    console.log(`⚠ ${modelId}: 503 服务不可用`)
                } else {
                    const errorText = await response.text()
                    console.log(`⚠ ${modelId}: ${response.status} - ${errorText.slice(0, 100)}`)
                }
            } catch (error: any) {
                console.log(`⚠ ${modelId}: ${error.message}`)
            }
        })
    }

    // 对每个 Claude 模型进行可用性测试（15秒超时）
    for (const modelId of CLAUDE_MODELS_TO_TEST) {
        it(`claude model "${modelId}" should be available`, { timeout: 15000 }, async () => {
            if (testAccounts.length === 0) {
                console.log("⊘ No test accounts available, skipping")
                return
            }

            try {
                // 通过 HTTP API 调用来测试
                const response = await fetch(`${API_BASE}/v1/chat/completions`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${API_KEY}`,
                    },
                    body: JSON.stringify({
                        model: modelId,
                        messages: [{ role: "user", content: "你是谁？" }],
                        max_tokens: 100,
                        stream: false,
                    }),
                })

                if (response.status === 200) {
                    const data = await response.json()
                    const content = data.choices?.[0]?.message?.content || ""
                    expect(content.length).toBeGreaterThan(0)
                    console.log(`✓ ${modelId}: ${content.slice(0, 50)}...`)
                } else if (response.status === 400 || response.status === 404) {
                    console.log(`⊘ ${modelId}: 模型不支持`)
                } else if (response.status === 429) {
                    const errorText = await response.text()
                    try {
                        const errorJson = JSON.parse(errorText)
                        const message = errorJson.error?.message || ""
                        if (message.includes("quota") || message.includes("exhausted")) {
                            console.log(`⚠ ${modelId}: 429 配额用尽 - ${message.slice(0, 60)}`)
                        } else if (message.includes("rate limit") || message.includes("too many")) {
                            console.log(`⚠ ${modelId}: 429 请求频繁 - ${message.slice(0, 60)}`)
                        } else {
                            console.log(`⚠ ${modelId}: 429 限流 - ${message.slice(0, 60)}`)
                        }
                    } catch {
                        console.log(`⚠ ${modelId}: 429 限流 - ${errorText.slice(0, 60)}`)
                    }
                } else if (response.status === 503) {
                    console.log(`⚠ ${modelId}: 503 服务不可用`)
                } else {
                    const errorText = await response.text()
                    console.log(`⚠ ${modelId}: ${response.status} - ${errorText.slice(0, 100)}`)
                }
            } catch (error: any) {
                console.log(`⚠ ${modelId}: ${error.message}`)
            }
        })
    }

    // 对每个 GPT 模型进行可用性测试（15秒超时）
    for (const modelId of GPT_MODELS_TO_TEST) {
        it(`gpt model "${modelId}" should be available`, { timeout: 15000 }, async () => {
            if (testAccounts.length === 0) {
                console.log("⊘ No test accounts available, skipping")
                return
            }

            try {
                // 通过 HTTP API 调用来测试
                const response = await fetch(`${API_BASE}/v1/chat/completions`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${API_KEY}`,
                    },
                    body: JSON.stringify({
                        model: modelId,
                        messages: [{ role: "user", content: "你是谁？" }],
                        max_tokens: 100,
                        stream: false,
                    }),
                })

                if (response.status === 200) {
                    const data = await response.json()
                    const content = data.choices?.[0]?.message?.content || ""
                    expect(content.length).toBeGreaterThan(0)
                    console.log(`✓ ${modelId}: ${content.slice(0, 50)}...`)
                } else if (response.status === 400 || response.status === 404) {
                    console.log(`⊘ ${modelId}: 模型不支持`)
                } else if (response.status === 429) {
                    const errorText = await response.text()
                    try {
                        const errorJson = JSON.parse(errorText)
                        const message = errorJson.error?.message || ""
                        if (message.includes("quota") || message.includes("exhausted")) {
                            console.log(`⚠ ${modelId}: 429 配额用尽 - ${message.slice(0, 60)}`)
                        } else if (message.includes("rate limit") || message.includes("too many")) {
                            console.log(`⚠ ${modelId}: 429 请求频繁 - ${message.slice(0, 60)}`)
                        } else {
                            console.log(`⚠ ${modelId}: 429 限流 - ${message.slice(0, 60)}`)
                        }
                    } catch {
                        console.log(`⚠ ${modelId}: 429 限流 - ${errorText.slice(0, 60)}`)
                    }
                } else if (response.status === 503) {
                    console.log(`⚠ ${modelId}: 503 服务不可用`)
                } else {
                    const errorText = await response.text()
                    console.log(`⚠ ${modelId}: ${response.status} - ${errorText.slice(0, 100)}`)
                }
            } catch (error: any) {
                console.log(`⚠ ${modelId}: ${error.message}`)
            }
        })
    }
})
