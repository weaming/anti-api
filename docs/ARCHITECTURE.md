# Architecture / 架构设计

## System Overview / 系统概览

```
┌─────────────────────────────────────────────────────────────────┐
│                         Anti-API                                │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  OpenAI API  │  │ Anthropic API│  │  Dashboard   │          │
│  │  /v1/chat/*  │  │ /v1/messages │  │   /quota     │          │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘          │
│         │                 │                                     │
│         └────────┬────────┘                                     │
│                  ▼                                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Routing Service                       │   │
│  │    - Flow selection (model → account mapping)            │   │
│  │    - Account rotation on 429 errors                      │   │
│  │    - Fallback handling                                   │   │
│  └─────────────────────────┬───────────────────────────────┘   │
│                            ▼                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Rate Limiter                          │   │
│  │    - 1 request per second minimum                        │   │
│  │    - Exclusive lock for serial processing                │   │
│  └─────────────────────────┬───────────────────────────────┘   │
│                            ▼                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Antigravity  │  │    Codex     │  │   Copilot    │          │
│  │   Provider   │  │   Provider   │  │   Provider   │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
              ┌──────────────────────────┐
              │   Upstream Cloud APIs    │
              │ (Google, Microsoft, etc) │
              └──────────────────────────┘
```

---

## Module Structure / 模块结构

### Core Modules / 核心模块

| Module | Path | Responsibility |
|--------|------|----------------|
| **Server** | `src/server.ts` | Hono HTTP server, routes, middleware |
| **Main** | `src/main.ts` | CLI entry, server startup, OAuth flow |
| **State** | `src/lib/state.ts` | Global runtime state |

### Request Handling / 请求处理

| Module | Path | Responsibility |
|--------|------|----------------|
| **OpenAI Route** | `src/routes/openai/` | OpenAI format handling |
| **Messages Route** | `src/routes/messages/` | Anthropic format handling |
| **Translator** | `src/routes/openai/translator.ts` | Format conversion |

### Providers / 提供者

| Module | Path | Responsibility |
|--------|------|----------------|
| **Antigravity** | `src/services/antigravity/` | Google Antigravity API |
| **Codex** | `src/services/codex/` | ChatGPT Codex API |
| **Copilot** | `src/services/copilot/` | GitHub Copilot API |

### Routing / 路由

| Module | Path | Responsibility |
|--------|------|----------------|
| **Router** | `src/services/routing/router.ts` | Request routing logic |
| **Config** | `src/services/routing/config.ts` | Flow configuration |
| **Models** | `src/services/routing/models.ts` | Available models |

### Infrastructure / 基础设施

| Module | Path | Responsibility |
|--------|------|----------------|
| **Rate Limiter** | `src/lib/rate-limiter.ts` | Request throttling |
| **Auth Store** | `src/services/auth/store.ts` | Account management |
| **Tunnel Manager** | `src/services/tunnel-manager.ts` | ngrok/cloudflared |

---

## Request Flow / 请求流程

```
1. HTTP Request arrives
       │
       ▼
2. Route handler (OpenAI or Anthropic)
       │
       ▼
3. Acquire rate limiter lock
       │
       ▼
4. Routing service selects flow
       │
       ▼
5. Try first account in flow
       │
       ├── Success (200) ──────────────────┐
       │                                    │
       ▼                                    │
6. On 429/500: Mark account rate-limited   │
       │                                    │
       ▼                                    │
7. Rotate to next available account        │
       │                                    │
       ▼                                    │
8. Retry with new account                  │
       │                                    │
       └──────────────────────────────────▶▼
                                     9. Return response
```

---

## Account Rotation / 账户轮换

```typescript
// Simplified logic
for (const entry of flowEntries) {
    try {
        const response = await callProvider(entry)
        return response // Success
    } catch (error) {
        if (error.status === 429) {
            markRateLimited(entry.accountId)
            continue // Try next account
        }
        throw error
    }
}
throw new Error("All accounts exhausted")
```

**Rate Limit Recovery:**
- 429 with `retry-after` header: Wait specified seconds
- 429 without header: Default 60s cooldown
- Quota exhausted: Mark until reset time

---

## Data Files / 数据文件

| File | Location | Purpose |
|------|----------|---------|
| `auth.json` | `~/.anti-api/auth.json` | OAuth tokens per account |
| `routing.json` | `~/.anti-api/routing.json` | Routing flow configuration |
| `settings.json` | `~/.anti-api/settings.json` | App settings |
| `remote-config.json` | `data/remote-config.json` | ngrok/tunnel config |

---

## Key Design Decisions / 设计决策

1. **Serial Request Processing**
   - Reason: Google API is sensitive to concurrent requests
   - Implementation: Rate limiter with exclusive lock

2. **Multi-Account Rotation**
   - Reason: Maximize available quota across accounts
   - Implementation: Auto-rotate on 429 errors

3. **Dual API Format**
   - Reason: Support both OpenAI and Anthropic clients
   - Implementation: Shared internal format, dual adapters
