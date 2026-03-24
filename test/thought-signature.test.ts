import { test, expect } from "bun:test"
import { claudeToAntigravity, parseApiResponse } from "../src/services/antigravity/chat"

test("claudeToAntigravity correctly maps thought_signature as a sibling", () => {
    const messages = [
        {
            role: "user" as const,
            content: "Check weather"
        },
        {
            role: "assistant" as const,
            content: [
                {
                    type: "tool_use" as const,
                    id: "call_1__THOUGHT__sig123",
                    name: "get_weather",
                    input: { city: "San Francisco" }
                },
                {
                    type: "tool_use" as const,
                    id: "call_2__THOUGHT__sig456",
                    name: "get_forecast",
                    input: { days: 5 }
                }
            ]
        },
        {
            role: "user" as const,
            content: [
                {
                    type: "tool_result" as const,
                    tool_use_id: "call_1__THOUGHT__sig123",
                    content: "Sunny, 20C"
                }
            ]
        }
    ]

    const result = claudeToAntigravity("gemini-3-flash", messages)
    const contents = result.request.contents
    
    // Check the assistant message (model role in Antigravity)
    const modelMessage = contents.find((c: any) => c.role === "model")
    expect(modelMessage).toBeDefined()
    
    const parts = modelMessage.parts
    // First tool call
    expect(parts[0].functionCall).toBeDefined()
    expect(parts[0].functionCall.name).toBe("get_weather")
    expect(parts[0].functionCall.id).toBe("call_1")
    
    // Sibling properties
    expect(parts[0].thought_signature).toBe("sig123")
    
    // Internal property should NOT exist
    expect(parts[0].functionCall.thought_signature).toBeUndefined()
    
    // Second tool call (Parallel case)
    expect(parts[1].functionCall).toBeDefined()
    expect(parts[1].functionCall.name).toBe("get_forecast")
    expect(parts[1].functionCall.id).toBe("call_2")
    
    // Second one should also have signature if provided in ID (Gemini rule update)
    expect(parts[1].thought_signature).toBe("sig456")

    // Check the tool response message (user role after assistant)
    const userResultMsg = contents.find((c: any) => c.role === "user" && c.parts[0].functionResponse)
    expect(userResultMsg).toBeDefined()
    expect(userResultMsg.parts[0].functionResponse).toBeDefined()
    expect(userResultMsg.parts[0].thought_signature).toBe("sig123") // Should be preserved from Tool ID
})

test("claudeToAntigravity handles thought_signature directly in content block", () => {
    const messages = [
        {
            role: "assistant" as const,
            content: [
                {
                    type: "tool_use" as const,
                    id: "call_abc",
                    name: "my_tool",
                    input: { x: 1 },
                    thought_signature: "direct_sig"
                } as any
            ]
        }
    ]

    const result = claudeToAntigravity("gemini-3-flash", messages)
    const modelMessage = result.request.contents[0]
    const part = modelMessage.parts[0]
    
    expect(part.thought_signature).toBe("direct_sig")
})

test("claudeToAntigravity retrieves signature from cache even if ID is truncated", () => {
    // 1. Simulate receiving a tool call from Gemini
    const geminiResponse = JSON.stringify([{
        response: {
            candidates: [{
                content: {
                    parts: [{
                        functionCall: {
                            name: "weather_tool",
                            args: { city: "SF" },
                            id: "long_id_123"
                        },
                        thought_signature: "very_long_signature_that_might_be_truncated"
                    }]
                }
            }]
        }
    }])
    
    // This call should trigger cacheSignature
    parseApiResponse(geminiResponse)
    
    // 2. Simulate a client that sends the ID back (e.g. without the __THOUGHT__ suffix)
    const messages = [
        {
            role: "assistant" as const,
            content: [
                {
                    type: "tool_use" as const,
                    id: "long_id_123", 
                    name: "weather_tool",
                    input: { city: "SF" }
                } as any
            ]
        }
    ]

    const result = claudeToAntigravity("gemini-3-flash", messages)
    const part = result.request.contents[0].parts[0]
    
    // Should be retrieved from cache
    expect(part.thought_signature).toBe("very_long_signature_that_might_be_truncated")
})
