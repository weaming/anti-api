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
    // 🆕 严格验证：只允许动态发现的模型（从上游quota API获取）
    // 这样可以确保只有上游实际支持的模型才能使用
    if (isDiscoveredModel(modelId)) return ["antigravity"]
    
    // 兜底：检查静态列表（用于启动时 quota 未刷新的情况）
    const isStatic = AVAILABLE_MODELS.some(m => m.id === modelId)
    if (isStatic) return ["antigravity"]

    return []
}

export function isOfficialModel(modelId: string): boolean {
    // 🆕 严格验证：优先检查动态发现的模型
    if (isDiscoveredModel(modelId)) return true
    
    // 兜底：检查静态列表
    return AVAILABLE_MODELS.some(m => m.id === modelId)
}
