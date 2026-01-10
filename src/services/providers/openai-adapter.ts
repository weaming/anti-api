import type { ClaudeMessage, ClaudeTool, ClaudeContentBlock } from "~/lib/translator"

export interface OpenAIChatMessage {
    role: "user" | "assistant" | "system" | "tool"
    content?: string | null
    tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
    tool_call_id?: string
}

export interface OpenAIToolDefinition {
    type: "function"
    function: {
        name: string
        description?: string
        parameters: any
    }
}

export function toOpenAITools(tools?: ClaudeTool[]): OpenAIToolDefinition[] | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map(tool => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
        },
    }))
}

function collectText(blocks: ClaudeContentBlock[]): string {
    return blocks
        .filter(block => block.type === "text" && block.text)
        .map(block => block.text)
        .join("")
}

export function toOpenAIMessages(messages: ClaudeMessage[]): OpenAIChatMessage[] {
    const result: OpenAIChatMessage[] = []

    for (const message of messages) {
        if (typeof message.content === "string") {
            result.push({ role: message.role, content: message.content })
            continue
        }

        const blocks = message.content as ClaudeContentBlock[]

        if (message.role === "assistant") {
            const text = collectText(blocks)
            const toolCalls = blocks
                .filter(block => block.type === "tool_use")
                .map(block => ({
                    id: block.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                    type: "function" as const,
                    function: {
                        name: block.name || "tool",
                        arguments: JSON.stringify(block.input || {}),
                    },
                }))

            result.push({
                role: "assistant",
                content: text || null,
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            })
            continue
        }

        if (message.role === "user") {
            const textBlocks = blocks.filter(block => block.type === "text")
            if (textBlocks.length > 0) {
                result.push({ role: "user", content: collectText(textBlocks) })
            }

            for (const block of blocks) {
                if (block.type === "tool_result") {
                    result.push({
                        role: "tool",
                        tool_call_id: block.tool_use_id || "tool",
                        content: typeof block.content === "string" ? block.content : JSON.stringify(block.content || {}),
                    })
                }
            }
        }
    }

    return result
}
