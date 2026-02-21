/**
 * Anti-API 配置
 * Antigravity API端点和模型映射
 */

// 默认端口
export const DEFAULT_PORT = 8964

// 支持的模型列表（用于/v1/models端点）
// ⚠ 仅包含上游 quota API 实际返回的模型
// 动态发现会自动添加新模型，这里仅作为兜底列表
export const AVAILABLE_MODELS = [
    // Claude 系列（上游实际返回）
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },

    // Gemini 3 系列
    { id: "gemini-3-pro-high", name: "Gemini 3 Pro (High)" },
    { id: "gemini-3-pro-low", name: "Gemini 3 Pro (Low)" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    
    // Gemini 3.1 系列
    { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
    { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },

    // GPT-OSS
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
]
