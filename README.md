# Anti-API

<p align="center">
  <strong>快速、好用的本地 API 代理服务！将 Antigravity 的顶级 AI 模型转换为 OpenAI/Anthropic 兼容的 API</strong>
</p>

---

> **注意**：本项目基于 Antigravity 逆向，未来兼容性无法保证。长期使用建议避免更新 Antigravity。

## ✨ 特性

- **🎯 智能路由** - 支持自定义 flow (route:fast) 和官方模型 ID (claude-3-5-sonnet) 的混合路由
- **🌐 远程访问** - 内置 ngrok 支持，一键生成公网地址
- **📊 完整面板** - 包含配额监控、路由配置、设置面板的 Web 界面
- **🔄 自动轮换** - 遇到 429 错误时自动无缝切换下一个账号
- **⚡ 双格式** - 同时兼容 OpenAI 和 Anthropic API 格式
- **🛠️ 工具调用** - 支持 Function Calling，完美适配 Claude Code

## 🚀 快速开始

### macOS 直接运行

运行 `fish start.fish` 即可启动。

### Docker 运行

```bash
docker run --rm -it \
  -p 8964:8964 \
  -v $HOME/.anti-api:/app/data \
  ghcr.io/weaming/anti-api:latest
```

或者使用 `docker-compose.yml`:

```bash
docker compose up -d
```

## ⚙️ 配置说明

### Claude Code 配置

添加到 `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8964",
    "ANTHROPIC_AUTH_TOKEN": "any-value"
  }
}
```

### 远程访问

访问 `http://localhost:8964/remote-panel`，配置 ngrok token 后即可一键开启公网访问。

### 路由系统

路由分为 **Flow 路由** (自定义 ID) 和 **Account 路由** (官方 ID)。
在 `http://localhost:8964/routing` 配置：

1. **混合使用**: 可以将 deepseekflow 指向多个账号
2. **账号链**: 为官方模型 ID 设置多个备用账号，自动故障转移

## 📝 开发

```bash
bun install
bun run src/main.ts start
```

## 📄 协议

MIT
