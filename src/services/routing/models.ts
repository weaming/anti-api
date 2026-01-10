import { AVAILABLE_MODELS } from "~/lib/config"
import type { AuthProvider } from "~/services/auth/types"

export interface ProviderModelOption {
    id: string
    label: string
}

export function getProviderModels(provider: AuthProvider): ProviderModelOption[] {
    if (provider === "antigravity") {
        return AVAILABLE_MODELS.map(model => ({
            id: model.id,
            label: model.name,
        }))
    }

    if (provider === "copilot") {
        return [
            { id: "claude-opus-4-5-thinking", label: "Copilot - Opus 4.5 Thinking" },
            { id: "claude-sonnet-4-5", label: "Copilot - Sonnet 4.5" },
            { id: "claude-sonnet-4-5-thinking", label: "Copilot - Sonnet 4.5 Thinking" },
            { id: "gpt-4o", label: "Copilot - GPT-4o" },
            { id: "gpt-4o-mini", label: "Copilot - GPT-4o Mini" },
            { id: "gpt-4.1", label: "Copilot - GPT-4.1" },
            { id: "gpt-4.1-mini", label: "Copilot - GPT-4.1 Mini" },
        ]
    }

    if (provider === "codex") {
        return [
            { id: "gpt-5.2-max-high", label: "Codex - 5.2 Max (High)" },
            { id: "gpt-5.2-max", label: "Codex - 5.2 Max" },
            { id: "gpt-5.2", label: "Codex - 5.2" },
            { id: "gpt-5.2-codex", label: "Codex - 5.2 Codex" },
            { id: "gpt-5.1", label: "Codex - 5.1" },
            { id: "gpt-5.1-codex", label: "Codex - 5.1 Codex" },
            { id: "gpt-5.1-codex-max", label: "Codex - 5.1 Codex Max" },
            { id: "gpt-5.1-codex-mini", label: "Codex - 5.1 Codex Mini" },
            { id: "gpt-5", label: "Codex - 5" },
            { id: "gpt-5-codex", label: "Codex - 5 Codex" },
            { id: "gpt-5-codex-mini", label: "Codex - 5 Codex Mini" },
            { id: "gpt-4o", label: "Codex - GPT-4o" },
            { id: "gpt-4o-mini", label: "Codex - GPT-4o Mini" },
            { id: "gpt-4.1", label: "Codex - GPT-4.1" },
        ]
    }

    return []
}
