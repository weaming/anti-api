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
    // 🆕 严格验证：优先检查动态发现的模型
    if (isDiscoveredModel(modelId)) return ["antigravity"]
    
    // 兜底：检查静态列表
    const isStatic = AVAILABLE_MODELS.some(m => m.id === modelId)
    if (isStatic) return ["antigravity"]

    // 🆕 回退：未知模型统一映射到 antigravity 尝试处理（chat.ts 内部会映射到 gemini-3-flash）
    return ["antigravity"]
}

export function isOfficialModel(modelId: string): boolean {
    // 🆕 恢复严格验证：只允许动态发现的模型或静态列表中的模型
    // 这样可以防止 handler.ts 中的 thinking 自动升级逻辑错误地升级不支持 thinking 的模型
    if (isDiscoveredModel(modelId)) return true
    
    // 兜底：检查静态列表
    return AVAILABLE_MODELS.some(m => m.id === modelId)
}
