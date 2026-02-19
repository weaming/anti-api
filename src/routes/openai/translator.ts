/**
 * OpenAI ↔ Anthropic 格式转换器
 */

import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import type { OpenAIMessage, OpenAITool } from "./types"

export function mapModel(openaiModel: string): string {
    return (openaiModel || "").trim().toLowerCase()
}

export function translateMessages(messages: OpenAIMessage[]): ClaudeMessage[] {
    return messages.map((msg) => {
        if (msg.role === "assistant" && msg.tool_calls) {
            return {
                role: "assistant" as const,
                content: msg.tool_calls.map((tc) => ({
                    type: "tool_use" as const,
                    id: tc.id,
                    name: tc.function.name,
                    input: JSON.parse(tc.function.arguments || "{}"),
                })),
            }
        }

        if (msg.role === "tool") {
            // For tool messages, ensure content is a string
            const toolContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || "")
            return {
                role: "user" as const,
                content: [{
                    type: "tool_result" as const,
                    tool_use_id: msg.tool_call_id!,
                    content: toolContent,
                }],
            }
        }

        // Map OpenAI roles to Claude roles
        // Claude only supports: user, assistant
        // OpenAI system and developer roles → Claude user role
        let claudeRole: "user" | "assistant" = "user"
        if (msg.role === "assistant") {
            claudeRole = "assistant"
        } else if (msg.role === "system") {
            // Instead of just converting to user role, preserve as system instruction for internal use
            // But since Claude doesn't support system role, we'll still map to "user" with special handling
            claudeRole = "user"
        }

        // Handle complex content (text + images) for OpenAI format
        if (typeof msg.content === 'object') {
            // This is an array of content blocks (OpenAI format with images)
            const contentBlocks: any[] = (msg.content as any).map((block: any) => {
                if (block.type === 'text') {
                    return {
                        type: 'text' as const,
                        text: block.text || ''
                    }
                } else if (block.type === 'image_url') {
                    // Extract base64 data from image URL
                    const imageUrl = block.image_url?.url || block.url
                    if (imageUrl && imageUrl.startsWith('data:')) {
                        // Extract MIME type and base64 data
                        const matches = imageUrl.match(/^data:(.+?);base64,(.+)$/)
                        if (matches) {
                            const mimeType = matches[1]
                            const base64Data = matches[2]
                            return {
                                type: 'image' as const,
                                source: {
                                    type: 'base64' as const,
                                    media_type: mimeType,
                                    data: base64Data
                                }
                            }
                        }
                    }
                    // If we cannot parse the image, treat as text
                    return {
                        type: 'text' as const,
                        text: `[Image: ${imageUrl}]`
                    }
                }
                return {
                    type: 'text' as const,
                    text: JSON.stringify(block)
                }
            })
            
            return {
                role: claudeRole,
                content: contentBlocks
            } as ClaudeMessage
        } else {
            // Simple string content
            return {
                role: claudeRole,
                content: msg.content || "",
            } as ClaudeMessage
        }
    })
}

export function translateTools(tools?: OpenAITool[]): ClaudeTool[] | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters || { type: "object", properties: {} },
    }))
}

export function mapStopReason(anthropicReason: string): "stop" | "length" | "tool_calls" | null {
    switch (anthropicReason) {
        case "end_turn": return "stop"
        case "tool_use": return "tool_calls"
        case "max_tokens": return "length"
        default: return "stop"
    }
}

export function generateChatId(): string {
    return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

export function buildStreamChunk(
    id: string,
    model: string,
    content?: string,
    role?: string,
    finishReason?: string,
    toolCalls?: any[]
): string {
    const chunk: any = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            delta: {},
            finish_reason: finishReason ? mapStopReason(finishReason) : null,
        }],
    }

    if (role) chunk.choices[0].delta.role = role
    if (content !== undefined) chunk.choices[0].delta.content = content
    if (toolCalls) {
        chunk.choices[0].delta.tool_calls = toolCalls.map((tc, idx) => ({
            index: idx,
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }))
    }

    return JSON.stringify(chunk)
}
