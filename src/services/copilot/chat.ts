import consola from "consola"
import { authStore } from "~/services/auth/store"
import { UpstreamError } from "~/lib/error"
import type { ProviderAccount } from "~/services/auth/types"
import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { toOpenAIMessages, toOpenAITools } from "~/services/providers/openai-adapter"

const COPILOT_COMPLETIONS_URL = "https://api.githubcopilot.com/chat/completions"
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"

interface CopilotTokenResponse {
    token: string
    expires_at?: number
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>()

interface OpenAIResponse {
    choices: Array<{
        message?: { content?: string | null; tool_calls?: any[] }
        finish_reason?: string | null
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export async function createCopilotCompletion(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number
) {
    const apiToken = await getCopilotApiToken(account)

    const requestBody = {
        model,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(tools),
        max_tokens: maxTokens,
    }

    const response = await fetch(COPILOT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiToken}`,
            "User-Agent": "anti-api/1.0",
            "Editor-Version": "vscode/1.95.0",
            "Editor-Plugin-Version": "copilot/1.300.0",
        },
        body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
        const errorText = await response.text()
        const retryAfter = response.headers.get("retry-after") || undefined
        throw new UpstreamError("copilot", response.status, errorText, retryAfter)
    }

    const data = await response.json() as OpenAIResponse
    const choice = data.choices?.[0]
    const content = choice?.message?.content || ""
    const toolCalls = choice?.message?.tool_calls || []

    const contentBlocks = []
    if (toolCalls.length > 0) {
        for (const call of toolCalls) {
            contentBlocks.push({
                type: "tool_use" as const,
                id: call.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                name: call.function?.name || "tool",
                input: safeParse(call.function?.arguments),
            })
        }
    }
    if (content) {
        contentBlocks.push({ type: "text" as const, text: content })
    }

    authStore.markSuccess("copilot", account.id)

    return {
        contentBlocks,
        stopReason: toolCalls.length > 0 ? "tool_use" : mapFinishReason(choice?.finish_reason),
        usage: {
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
        },
    }
}

async function getCopilotApiToken(account: ProviderAccount): Promise<string> {
    const cached = tokenCache.get(account.id)
    if (cached && cached.expiresAt > Date.now()) {
        return cached.token
    }

    const response = await fetch(COPILOT_TOKEN_URL, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${account.accessToken}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    })

    const data = await response.json() as CopilotTokenResponse
    if (!response.ok || !data.token) {
        throw new Error(`copilot:token:${response.status}:${JSON.stringify(data)}`)
    }

    const expiresAt = data.expires_at ? data.expires_at * 1000 : Date.now() + 10 * 60 * 1000
    tokenCache.set(account.id, { token: data.token, expiresAt })
    return data.token
}

function safeParse(value: string | undefined): any {
    if (!value) return {}
    try {
        return JSON.parse(value)
    } catch (error) {
        consola.warn("Copilot tool args parse failed:", error)
        return {}
    }
}

function mapFinishReason(reason?: string | null): string {
    if (!reason || reason === "stop") return "end_turn"
    if (reason === "length") return "max_tokens"
    if (reason === "tool_calls") return "tool_use"
    return reason
}
