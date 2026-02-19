/**
 * Input Validation Utility
 * Provides request validation for API security
 */

import {
    MAX_MESSAGES_PER_REQUEST,
    MAX_TOOLS_PER_REQUEST,
    MAX_MODEL_NAME_LENGTH,
    MAX_ACCOUNT_ID_LENGTH,
    MAX_TOKENS_LIMIT,
    MAX_SANITIZED_STRING_LENGTH,
} from "./constants"

export interface ValidationResult {
    valid: boolean
    error?: string
}

/**
 * Validate chat completion request body
 */
export function validateChatRequest(payload: any): ValidationResult {
    if (!payload || typeof payload !== "object") {
        return { valid: false, error: "Request body must be a JSON object" }
    }

    // Model validation
    if (!payload.model || typeof payload.model !== "string") {
        return { valid: false, error: "Model is required and must be a string" }
    }
    if (payload.model.length > MAX_MODEL_NAME_LENGTH) {
        return { valid: false, error: `Model name too long (max ${MAX_MODEL_NAME_LENGTH} characters)` }
    }

    // Messages validation
    if (!Array.isArray(payload.messages)) {
        return { valid: false, error: "Messages must be an array" }
    }
    if (payload.messages.length === 0) {
        return { valid: false, error: "Messages array cannot be empty" }
    }
    if (payload.messages.length > MAX_MESSAGES_PER_REQUEST) {
        return { valid: false, error: `Too many messages (max ${MAX_MESSAGES_PER_REQUEST})` }
    }

    for (let i = 0; i < payload.messages.length; i++) {
        const msg = payload.messages[i]
        if (!msg || typeof msg !== "object") {
            return { valid: false, error: `Message at index ${i} must be an object` }
        }
        if (!msg.role || typeof msg.role !== "string") {
            return { valid: false, error: `Message at index ${i} must have a role` }
        }
        const validRoles = ["system", "user", "assistant", "tool", "developer"]
        if (!validRoles.includes(msg.role)) {
            return { valid: false, error: `Invalid role "${msg.role}" at index ${i}` }
        }
        
        // Validate content - can be string or array of content blocks
        if (msg.content !== null && msg.content !== undefined) {
            if (typeof msg.content === 'string') {
                // Valid string content
            } else if (Array.isArray(msg.content)) {
                // Validate array of content blocks
                for (let j = 0; j < msg.content.length; j++) {
                    const block = msg.content[j]
                    if (!block || typeof block !== "object") {
                        return { valid: false, error: `Message content block at index ${i},${j} must be an object` }
                    }
                    if (!block.type || typeof block.type !== "string") {
                        return { valid: false, error: `Message content block at index ${i},${j} must have a type` }
                    }
                    
                    if (block.type === 'text') {
                        if (block.text !== undefined && typeof block.text !== 'string') {
                            return { valid: false, error: `Text content block at index ${i},${j} must have text as string` }
                        }
                    } else if (block.type === 'image_url') {
                        if (!block.image_url || typeof block.image_url !== 'object') {
                            return { valid: false, error: `Image content block at index ${i},${j} must have image_url object` }
                        }
                        if (!block.image_url.url || typeof block.image_url.url !== 'string') {
                            return { valid: false, error: `Image content block at index ${i},${j} must have image_url.url as string` }
                        }
                    }
                }
            } else {
                return { valid: false, error: `Message content at index ${i} must be a string or array of content blocks` }
            }
        }
    }

    // Optional fields validation
    if (payload.max_tokens !== undefined) {
        if (typeof payload.max_tokens !== "number" || payload.max_tokens <= 0) {
            return { valid: false, error: "max_tokens must be a positive number" }
        }
        if (payload.max_tokens > MAX_TOKENS_LIMIT) {
            return { valid: false, error: `max_tokens too large (max ${MAX_TOKENS_LIMIT})` }
        }
    }

    if (payload.temperature !== undefined) {
        if (typeof payload.temperature !== "number" || payload.temperature < 0 || payload.temperature > 2) {
            return { valid: false, error: "temperature must be a number between 0 and 2" }
        }
    }
    
    if (payload.top_p !== undefined) {
        if (typeof payload.top_p !== "number" || payload.top_p < 0 || payload.top_p > 1) {
            return { valid: false, error: "top_p must be a number between 0 and 1" }
        }
    }
    
    if (payload.top_k !== undefined) {
        if (typeof payload.top_k !== "number" || payload.top_k < 0) {
            return { valid: false, error: "top_k must be a non-negative number" }
        }
    }
    
    if (payload.presence_penalty !== undefined) {
        if (typeof payload.presence_penalty !== "number" || payload.presence_penalty < -2 || payload.presence_penalty > 2) {
            return { valid: false, error: "presence_penalty must be a number between -2 and 2" }
        }
    }
    
    if (payload.frequency_penalty !== undefined) {
        if (typeof payload.frequency_penalty !== "number" || payload.frequency_penalty < -2 || payload.frequency_penalty > 2) {
            return { valid: false, error: "frequency_penalty must be a number between -2 and 2" }
        }
    }
    
    if (payload.stop !== undefined) {
        if (typeof payload.stop !== "string" && !Array.isArray(payload.stop)) {
            return { valid: false, error: "stop must be a string or array of strings" }
        }
        if (Array.isArray(payload.stop)) {
            for (let i = 0; i < payload.stop.length; i++) {
                if (typeof payload.stop[i] !== "string") {
                    return { valid: false, error: `stop[${i}] must be a string` }
                }
            }
        }
    }
    
    if (payload.seed !== undefined) {
        if (typeof payload.seed !== "number" || payload.seed < 0 || !Number.isInteger(payload.seed)) {
            return { valid: false, error: "seed must be a non-negative integer" }
        }
    }

    if (payload.response_format !== undefined) {
        if (typeof payload.response_format !== "object" || payload.response_format === null) {
            return { valid: false, error: "response_format must be an object" }
        }
        if (payload.response_format.type !== "text" && payload.response_format.type !== "json_object") {
            return { valid: false, error: "response_format.type must be 'text' or 'json_object'" }
        }
    }

    if (payload.stream !== undefined && typeof payload.stream !== "boolean") {
        return { valid: false, error: "stream must be a boolean" }
    }

    // Tools validation
    if (payload.tools !== undefined) {
        if (!Array.isArray(payload.tools)) {
            return { valid: false, error: "tools must be an array" }
        }
        if (payload.tools.length > MAX_TOOLS_PER_REQUEST) {
            return { valid: false, error: `Too many tools (max ${MAX_TOOLS_PER_REQUEST})` }
        }
    }

    return { valid: true }
}

/**
 * Validate Anthropic messages request body
 */
export function validateAnthropicRequest(payload: any): ValidationResult {
    if (!payload || typeof payload !== "object") {
        return { valid: false, error: "Request body must be a JSON object" }
    }

    // Model validation
    if (!payload.model || typeof payload.model !== "string") {
        return { valid: false, error: "Model is required and must be a string" }
    }

    // Messages validation
    if (!Array.isArray(payload.messages)) {
        return { valid: false, error: "Messages must be an array" }
    }
    if (payload.messages.length === 0) {
        return { valid: false, error: "Messages array cannot be empty" }
    }

    for (let i = 0; i < payload.messages.length; i++) {
        const msg = payload.messages[i]
        if (!msg || typeof msg !== "object") {
            return { valid: false, error: `Message at index ${i} must be an object` }
        }
        if (!msg.role || typeof msg.role !== "string") {
            return { valid: false, error: `Message at index ${i} must have a role` }
        }
    }

    // max_tokens validation (required for Anthropic)
    if (payload.max_tokens !== undefined) {
        if (typeof payload.max_tokens !== "number" || payload.max_tokens <= 0) {
            return { valid: false, error: "max_tokens must be a positive number" }
        }
    }

    return { valid: true }
}

/**
 * Sanitize string input to prevent injection
 */
export function sanitizeString(input: string, maxLength: number = MAX_SANITIZED_STRING_LENGTH): string {
    if (typeof input !== "string") return ""
    return input.slice(0, maxLength)
}

/**
 * Validate account ID format
 */
export function validateAccountId(id: string): boolean {
    if (!id || typeof id !== "string") return false
    // Only allow alphanumeric, dash, underscore, @ and .
    return /^[a-zA-Z0-9@._-]+$/.test(id) && id.length <= MAX_ACCOUNT_ID_LENGTH
}
