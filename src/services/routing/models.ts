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
    return []
}

export function getOfficialModelProviders(modelId: string): string[] {
    const isAntigravity = AVAILABLE_MODELS.some(m => m.id === modelId)
    if (isAntigravity) return ["antigravity"]
    return []
}

export function isOfficialModel(modelId: string): boolean {
    return AVAILABLE_MODELS.some(m => m.id === modelId)
}

