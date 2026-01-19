/**
 * OpenAI /v1/chat/completions 端点处理器
 */

import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import consola from "consola"

import { createChatCompletion, createChatCompletionStream } from "~/services/antigravity/chat"
import type { OpenAIChatCompletionRequest } from "./types"
import {
    mapModel,
    translateMessages,
    translateTools,
    generateChatId,
    buildStreamChunk,
    mapStopReason,
} from "./translator"
import { validateChatRequest } from "~/lib/validation"
import { rateLimiter } from "~/lib/rate-limiter"

export async function handleChatCompletion(c: Context): Promise<Response> {
    // 🆕 获取全局锁 - 确保请求串行化
    const releaseLock = await rateLimiter.acquireExclusive()
    let releaseInFinally = true

    try {
        const payload = await c.req.json<OpenAIChatCompletionRequest>()

        // Input validation
        const validation = validateChatRequest(payload)
        if (!validation.valid) {
            releaseLock()
            return c.json({ error: { type: "invalid_request_error", message: validation.error } }, 400)
        }

        const anthropicModel = mapModel(payload.model)
        const messages = translateMessages(payload.messages)
        const tools = translateTools(payload.tools)

        if (payload.stream) {
            const response = await handleStreamCompletion(c, payload, anthropicModel, messages, tools, releaseLock)
            releaseInFinally = false
            return response
        }

        const result = await createChatCompletion({
            model: anthropicModel,
            messages,
            tools,
            maxTokens: payload.max_tokens || 4096,
        })

        let textContent = ""
        const toolCalls: any[] = []

        for (const block of result.contentBlocks) {
            if (block.type === "text") {
                textContent += block.text || ""
            } else if (block.type === "tool_use") {
                toolCalls.push({ id: block.id, name: block.name, input: block.input })
            }
        }

        const message: any = { role: "assistant", content: toolCalls.length > 0 ? null : textContent }
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            }))
        }

        // Token counts for response (Usage recording is handled in chat.ts with actual native model ID)
        const inputTokens = result.usage?.inputTokens || 0
        const outputTokens = result.usage?.outputTokens || 0

        return c.json({
            id: generateChatId(),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: payload.model,
            choices: [{ index: 0, message, finish_reason: mapStopReason(result.stopReason || "end_turn") }],
            usage: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
            },
        })
    } catch (error) {
        consola.error("OpenAI completion error:", error)
        return c.json({ error: { message: (error as Error).message, type: "api_error" } }, 500)
    } finally {
        if (releaseInFinally) {
            releaseLock()
        }
    }
}

async function handleStreamCompletion(
    c: Context,
    payload: OpenAIChatCompletionRequest,
    anthropicModel: string,
    messages: any[],
    tools: any[] | undefined,
    releaseLock: () => void
): Promise<Response> {
    const chatId = generateChatId()

    return streamSSE(c, async (stream) => {
        try {
            const chatStream = createChatCompletionStream({
                model: anthropicModel,
                messages,
                tools,
                maxTokens: payload.max_tokens || 4096,
            })

            let sentRole = false
            let accumulatedToolCalls: any[] = []
            let currentToolCall: any = null
            let streamInputTokens = 0
            let streamOutputTokens = 0

            for await (const event of chatStream) {
                const lines = event.split("\n")
                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue
                    const data = line.slice(6)
                    if (data === "[DONE]") continue

                    try {
                        const parsed = JSON.parse(data)
                        const eventType = parsed.type

                        switch (eventType) {
                            case "message_start":
                                if (!sentRole) {
                                    await stream.writeSSE({ data: buildStreamChunk(chatId, payload.model, undefined, "assistant") })
                                    sentRole = true
                                }
                                // Capture input tokens from message_start
                                if (parsed.message?.usage?.input_tokens) {
                                    streamInputTokens = parsed.message.usage.input_tokens
                                }
                                break

                            case "content_block_start":
                                if (parsed.content_block?.type === "tool_use") {
                                    currentToolCall = {
                                        id: parsed.content_block.id,
                                        name: parsed.content_block.name,
                                        input: {},
                                        arguments: "",
                                    }
                                }
                                break

                            case "content_block_delta":
                                if (parsed.delta?.type === "text_delta" && parsed.delta?.text) {
                                    await stream.writeSSE({ data: buildStreamChunk(chatId, payload.model, parsed.delta.text) })
                                } else if (parsed.delta?.type === "input_json_delta" && currentToolCall) {
                                    currentToolCall.arguments += parsed.delta.partial_json || ""
                                }
                                break

                            case "content_block_stop":
                                if (currentToolCall) {
                                    try { currentToolCall.input = JSON.parse(currentToolCall.arguments || "{}") } catch { currentToolCall.input = {} }
                                    accumulatedToolCalls.push(currentToolCall)
                                    currentToolCall = null
                                }
                                break

                            case "message_delta":
                                const stopReason = parsed.delta?.stop_reason || "end_turn"
                                // Capture output tokens from message_delta
                                if (parsed.usage?.output_tokens) {
                                    streamOutputTokens = parsed.usage.output_tokens
                                }
                                if (accumulatedToolCalls.length > 0) {
                                    await stream.writeSSE({ data: buildStreamChunk(chatId, payload.model, undefined, undefined, "tool_use", accumulatedToolCalls) })
                                }
                                await stream.writeSSE({ data: buildStreamChunk(chatId, payload.model, undefined, undefined, stopReason) })
                                break
                        }
                    } catch (e) { }
                }
            }


            // Note: Usage recording is handled in chat.ts with the actual native model ID

            await stream.writeSSE({ data: "[DONE]" })
        } catch (error) {
            consola.error("OpenAI stream error:", error)
            await stream.writeSSE({ data: JSON.stringify({ error: { message: (error as Error).message, type: "api_error" } }) })
        } finally {
            releaseLock()
        }
    })
}
