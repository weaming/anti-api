# Troubleshooting / 故障排查

## Common Issues / 常见问题

---

### 1. 429 Rate Limit Errors / 429 限速错误

**Symptoms / 症状:**
```
429: Rate limited >> account@gmail.com
```

**Causes / 原因:**
- Account quota exhausted / 账户配额耗尽
- Too many concurrent requests / 并发请求过多
- Sending requests too fast / 请求过快

**Solutions / 解决方案:**
1. Add more accounts in Quota dashboard / 在配额面板添加更多账户
2. Wait for quota reset (check reset time in Quota) / 等待配额重置
3. Reduce request frequency / 降低请求频率
4. Check console for rotation logs:
   ```
   429: Rate limited >> account1@gmail.com    (red)
   → Switching to: account2@gmail.com         (yellow)
   200: from claude-opus > Antigravity >> account2  (green)
   ```

---

### 2. ngrok Connection Failed / ngrok 连接失败

**Symptoms / 症状:**
```
ERROR  Failed to get ngrok URL after 15 attempts
```

**Causes / 原因:**
- Previous ngrok process still running / 之前的 ngrok 进程仍在运行
- Port 4040 occupied / 端口 4040 被占用
- ngrok authtoken invalid or missing / authtoken 无效或缺失

**Solutions / 解决方案:**

1. Kill existing ngrok processes:
   ```bash
   killall ngrok
   ```

2. Check port 4040:
   ```bash
   lsof -i :4040
   # Kill if occupied:
   kill -9 <PID>
   ```

3. Verify authtoken in Remote panel:
   - Go to `http://localhost:8964/remote-panel`
   - Enter your ngrok authtoken
   - Click Start

4. Try manual start:
   ```bash
   ngrok http 8964
   ```

---

### 3. Quota Not Loading / 配额不显示

**Symptoms / 症状:**
- Some accounts show 0% quota
- Quota bars empty on first load

**Causes / 原因:**
- OAuth token expired / OAuth 令牌过期
- Network timeout on first request / 首次请求网络超时
- Certificate validation issues / 证书验证问题

**Solutions / 解决方案:**

1. Click **Refresh** button to retry / 点击刷新按钮重试

2. Re-authenticate account:
   - Delete account in Quota panel
   - Re-add via OAuth

3. Check console for errors:
   ```
   [warn] Antigravity quota fetch failed: ...
   ```

4. Ensure Antigravity is running and authenticated

---

### 4. OAuth Login Failed / OAuth 登录失败

**Symptoms / 症状:**
- Browser opens but login fails
- "Access Denied" error
- Redirect loop

**Solutions / 解决方案:**

1. Use correct Google account with Antigravity access

2. Check if port 51121 is available:
   ```bash
   lsof -i :51121
   ```

3. Try logging in via Antigravity app first

4. Clear browser cookies and retry

---

### 5. Streaming Not Working / 流式响应不工作

**Symptoms / 症状:**
- Response comes all at once
- No incremental updates

**Solutions / 解决方案:**

1. Ensure `stream: true` in request:
   ```json
   {"model": "...", "messages": [...], "stream": true}
   ```

2. Check client supports SSE (Server-Sent Events)

3. Check for proxy/firewall blocking chunked transfer

---

### 6. Tool Calling Errors / 工具调用错误

**Symptoms / 症状:**
- `tool_calls` not returned
- Arguments parsing fails

**Solutions / 解决方案:**

1. Verify tool schema format:
   ```json
   {
     "type": "function",
     "function": {
       "name": "tool_name",
       "description": "...",
       "parameters": {"type": "object", "properties": {...}}
     }
   }
   ```

2. Use a model that supports tools (Claude, Gemini Pro)

---

### 7. Server Won't Start / 服务无法启动

**Symptoms / 症状:**
```
Error: Port 8964 already in use
```

**Solutions / 解决方案:**

1. Kill existing process:
   ```bash
   # macOS/Linux
   lsof -ti :8964 | xargs kill -9
   
   # Windows
   netstat -ano | findstr :8964
   taskkill /PID <PID> /F
   ```

2. Use a different port:
   ```bash
   bun run src/main.ts start --port 8080
   ```

---

## Getting Help / 获取帮助

1. Check console logs for detailed error messages
2. Enable debug mode by setting `consola.level = 4` in `server.ts`
3. Open an issue on GitHub with:
   - Error message
   - Steps to reproduce
   - Console output
