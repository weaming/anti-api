/**
 * Auth 路由
 */

import { Hono } from "hono"
import { isAuthenticated, getUserInfo, setAuth, clearAuth, startOAuthLogin, pollAntigravitySession } from "~/services/antigravity/login"
import { accountManager } from "~/services/antigravity/account-manager"
import { state } from "~/lib/state"
import { authStore } from "~/services/auth/store"

export const authRouter = new Hono()

// 获取认证状态
authRouter.get("/status", (c) => {
    const userInfo = getUserInfo()
    return c.json({
        authenticated: isAuthenticated(),
        email: userInfo.email,
        name: userInfo.name,
    })
})

authRouter.get("/accounts", (c) => {
    accountManager.load()
    return c.json({
        accounts: {
            antigravity: authStore.listSummaries("antigravity"),
        },
    })
})

// 登录（触发 OAuth 或设置 token）
authRouter.post("/login", async (c) => {
    try {
        // 尝试解析 body，如果为空则触发 OAuth
        let body: { accessToken?: string; refreshToken?: string; email?: string; name?: string; provider?: string; force?: boolean } = {}
        try {
            const text = await c.req.text()
            if (text && text.trim()) {
                body = JSON.parse(text)
            }
        } catch {
            // body 为空或无效 JSON
        }

        const provider = (body.provider || "antigravity").toLowerCase()

        if (provider !== "antigravity") {
            return c.json({ success: false, error: "Only Antigravity provider is supported" }, 400)
        }

        // 默认 Antigravity
        if (!body.accessToken) {
            const result = await startOAuthLogin()
            if (result.success) {
                return c.json({
                    success: true,
                    status: "pending",
                    provider: "antigravity",
                    authUrl: result.authUrl,
                    sessionId: result.sessionId,
                })
            } else {
                return c.json({ success: false, error: result.error }, 400)
            }
        }

        // Fallback for direct token auth
        setAuth(body.accessToken, body.refreshToken, body.email, body.name)
        accountManager.load()
        accountManager.addAccount({
            id: body.email || `account-${Date.now()}`,
            email: body.email || "unknown",
            accessToken: body.accessToken,
            refreshToken: body.refreshToken || "",
            expiresAt: state.tokenExpiresAt || 0,
            projectId: state.cloudaicompanionProject,
        })
        return c.json({
            success: true,
            authenticated: true,
            provider: "antigravity",
            email: body.email,
            name: body.name,
        })
    } catch (error) {
        return c.json({ error: (error as Error).message }, 500)
    }
})

authRouter.get("/antigravity/status", async (c) => {
    const sessionId = c.req.query("session_id")
    if (!sessionId) {
        return c.json({ success: false, error: "session_id required" }, 400)
    }
    const result = await pollAntigravitySession(sessionId)
    return c.json({
        success: result.status === "success",
        ...result,
    })
})

// 登出
authRouter.post("/logout", (c) => {
    clearAuth()
    return c.json({ success: true, authenticated: false })
})
