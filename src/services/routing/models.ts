import { AVAILABLE_MODELS } from "~/lib/config"
import type { AuthProvider } from "~/services/auth/types"
import { isDiscoveredModel, getAllKnownModelIds } from "~/services/model-discovery"

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
    // 优先检查静态列表
    const isStatic = AVAILABLE_MODELS.some(m => m.id === modelId)
    if (isStatic) return ["antigravity"]

    // 检查动态发现的模型
    if (isDiscoveredModel(modelId)) return ["antigravity"]

    return []
}

export function isOfficialModel(modelId: string): boolean {
    // 优先检查静态列表
    if (AVAILABLE_MODELS.some(m => m.id === modelId)) return true

    // 检查动态发现的模型
    return isDiscoveredModel(modelId)
}
