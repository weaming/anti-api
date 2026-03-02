#!/bin/bash
# 测试 API 可用模型列表和模型选择

API_BASE="${1:-http://localhost:8964}"

echo "=== 1. 获取可用模型列表 ==="
echo "GET $API_BASE/v1/models"
echo ""
curl -s "$API_BASE/v1/models" | jq '.data[] | {id, display_name}'

echo ""
echo "=== 2. 测试用 gemini-3-flash 发送请求 (Anthropic 格式) ==="
echo "POST $API_BASE/v1/messages"
echo ""
curl -s -w "\nHTTP Status: %{http_code}\n" "$API_BASE/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test" \
  -d '{
    "model": "gemini-3-flash",
    "max_tokens": 32,
    "stream": false,
    "messages": [{"role": "user", "content": "Say hi"}]
  }' | head -20

echo ""
echo "=== 3. 测试用 gemini-3-flash 发送请求 (OpenAI 格式) ==="
echo "POST $API_BASE/v1/chat/completions"
echo ""
curl -s -w "\nHTTP Status: %{http_code}\n" "$API_BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{
    "model": "gemini-3-flash",
    "max_tokens": 32,
    "stream": false,
    "messages": [{"role": "user", "content": "Say hi"}]
  }' | head -20
