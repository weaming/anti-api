/**
 * OpenAI tool_choice 参数转换为 Anthropic 格式
 */
export function translateToolChoice(
    toolChoice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } }
): { type: "auto" | "any" | "tool"; name?: string } | undefined {
    if (!toolChoice || toolChoice === "auto") {
        return { type: "auto" }
    }
    if (toolChoice === "required") {
        return { type: "any" }
    }
    if (toolChoice === "none") {
        return undefined
    }
    if (typeof toolChoice === "object" && toolChoice.type === "function") {
        return {
            type: "tool",
            name: toolChoice.function.name,
        }
    }
    return { type: "auto" }
}
