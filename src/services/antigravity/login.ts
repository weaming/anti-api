/**
 * Antigravity OAuth 登录服务
 * 完整的 OAuth 登录流程实现
 */

import { state } from "~/lib/state"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import consola from "consola"
import {
    startOAuthCallbackServer,
    generateState,
    generateAuthURL,
    exchangeCode,
    fetchUserInfo,
    getProjectID,
    refreshAccessToken,
} from "./oauth"
import { generateMockProjectId } from "./project-id"
import { ensureDataDir, getDataDir, getLegacyProjectDataDir } from "~/lib/data-dir"
import { accountManager } from "./account-manager"

const AUTH_FILE = join(getDataDir(), "auth.json")
const LEGACY_AUTH_FILE = join(getLegacyProjectDataDir(), "auth.json")

interface AuthData {
    accessToken: string
    refreshToken: string
    userEmail?: string
    userName?: string
    expiresAt?: number
    projectId?: string
}

// 用于存储进行中的 Antigravity 登录会话
const pendingAntigravitySessions = new Map<string, AntigravitySession>()

interface AntigravitySession {
    status: "pending" | "success" | "error"
    server: any
    waitForCallback: () => Promise<any>
    redirectUri: string
    oauthState: string
    result?: any // 成功或失败的结果
}

/**
 * 初始化认证 - 从文件加载已保存的认证
 */
export function initAuth(): void {
    try {
        const source = existsSync(AUTH_FILE) ? AUTH_FILE : (existsSync(LEGACY_AUTH_FILE) ? LEGACY_AUTH_FILE : null)
        if (source) {
            const data = JSON.parse(readFileSync(source, "utf-8")) as AuthData
            if (data.accessToken) {
                state.accessToken = data.accessToken
                state.antigravityToken = data.accessToken
                state.refreshToken = data.refreshToken || null
                state.tokenExpiresAt = data.expiresAt || null
                state.userEmail = data.userEmail || null
                state.userName = data.userName || null
                state.cloudaicompanionProject = data.projectId || null
                if (source === LEGACY_AUTH_FILE && !existsSync(AUTH_FILE)) {
                    saveAuth()
                }
                consola.success("Loaded saved authentication")
            }
        }
    } catch (error) {
        consola.warn("Failed to load saved auth:", error)
    }
}

/**
 * 保存认证到文件
 */
export function saveAuth(): void {
    try {
        ensureDataDir()

        const data: AuthData = {
            accessToken: state.accessToken!,
            refreshToken: state.refreshToken || "",
            expiresAt: state.tokenExpiresAt || undefined,
            userEmail: state.userEmail || undefined,
            userName: state.userName || undefined,
            projectId: state.cloudaicompanionProject || undefined,
        }

        writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2))
        consola.success("Authentication saved")
    } catch (error) {
        consola.error("Failed to save auth:", error)
    }
}

/**
 * 清除认证
 */
export function clearAuth(): void {
    state.accessToken = null
    state.antigravityToken = null
    state.refreshToken = null
    state.userEmail = null
    state.userName = null
    state.cloudaicompanionProject = null

    try {
        if (existsSync(AUTH_FILE)) {
            writeFileSync(AUTH_FILE, "{}")
        }
        if (existsSync(LEGACY_AUTH_FILE)) {
            writeFileSync(LEGACY_AUTH_FILE, "{}")
        }
    } catch (error) {
        consola.warn("Failed to clear auth file:", error)
    }
}

/**
 * 检查是否已认证
 */
export function isAuthenticated(): boolean {
    return !!state.accessToken
}

/**
 * 获取用户信息
 */
export function getUserInfo(): { email: string | null; name: string | null } {
    return {
        email: state.userEmail,
        name: state.userName,
    }
}

/**
 * 设置认证信息
 */
export function setAuth(accessToken: string, refreshToken?: string, email?: string, name?: string): void {
    state.accessToken = accessToken
    state.antigravityToken = accessToken
    state.refreshToken = refreshToken || null
    state.userEmail = email || null
    state.userName = name || null
    saveAuth()
}

/**
 * 启动 OAuth 登录流程
 */
export async function startOAuthLogin(): Promise<{ success: boolean; error?: string; email?: string, authUrl?: string, sessionId?: string }> {
    try {
        const { authUrl, sessionId } = await startAntigravityDeviceFlow()
        return { success: true, authUrl, sessionId }
    } catch (error) {
        return { success: false, error: (error as Error).message }
    }
}

/**
 * 启动 Antigravity 设备流程（用于浏览器端）
 */
export async function startAntigravityDeviceFlow(): Promise<{ authUrl: string; sessionId: string }> {
    consola.debug("[Auth] Starting Antigravity device flow...")
    // 1. 启动回调服务器
    const { server, port, waitForCallback } = await startOAuthCallbackServer()

    // 2. 生成授权 URL 和会话 ID
    const sessionId = generateState() // 使用 state 作为 sessionId
    const redirectUri = process.env.ANTI_API_OAUTH_REDIRECT_URL || `http://localhost:${port}/oauth-callback`
    const authUrl = generateAuthURL(redirectUri, sessionId)
    consola.debug(`[Auth] Session ${sessionId}: Auth URL created: ${authUrl}`)

    // 3. 存储会话信息以供轮询
    const session: AntigravitySession = {
        status: "pending",
        server,
        waitForCallback,
        redirectUri,
        oauthState: sessionId,
    }
    pendingAntigravitySessions.set(sessionId, session)
    consola.debug(`[Auth] Session ${sessionId}: Stored, waiting for callback.`)

    // 4. 等待回调并在后台处理
    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Authentication timeout (5 minutes)")), 5 * 60 * 1000)
    })

    Promise.race([waitForCallback(), timeoutPromise])
        .then(result => {
            consola.debug(`[Auth] Session ${sessionId}: Callback received.`)
            session.status = "success"
            session.result = result
        })
        .catch(error => {
            consola.error(`[Auth] Session ${sessionId}: Error during callback wait: ${error.message}`)
            session.status = "error"
            session.result = error
        })

    return { authUrl, sessionId }
}

/**
 * 轮询 Antigravity 登录状态
 */
export async function pollAntigravitySession(sessionId: string): Promise<{
    status: "pending" | "success" | "error"
    message?: string
    account?: { id: string; email: string }
}> {
    consola.debug(`[Auth] Polling for session ${sessionId}...`)
    const session = pendingAntigravitySessions.get(sessionId)
    if (!session) {
        consola.warn(`[Auth] Polling for session ${sessionId}: Not found.`)
        return { status: "error", message: "Session not found or expired" }
    }

    if (session.status === "pending") {
        consola.debug(`[Auth] Polling for session ${sessionId}: Still pending.`)
        return { status: "pending", message: "Waiting for user authentication..." }
    }

    // 会话已完成（成功或失败），处理结果
    consola.debug(`[Auth] Polling for session ${sessionId}: Completed with status '${session.status}'. Processing...`)
    pendingAntigravitySessions.delete(sessionId)
    consola.debug(`[Auth] Session ${sessionId}: Deleted from memory. Stopping server...`)
    session.server.stop()
    consola.debug(`[Auth] Session ${sessionId}: Server stopped.`)

    if (session.status === "error") {
        consola.error(`[Auth] Session ${sessionId}: Failed. Reason: ${session.result.message}`)
        return { status: "error", message: session.result.message || "Authentication failed" }
    }

    try {
        const callbackResult = session.result
        if (callbackResult.error) {
            consola.error(`[Auth] Session ${sessionId}: Callback result contained an error: ${callbackResult.error}`)
            return { status: "error", message: callbackResult.error }
        }
        if (!callbackResult.code || !callbackResult.state || callbackResult.state !== session.oauthState) {
            consola.error(`[Auth] Session ${sessionId}: Invalid callback state. Expected ${session.oauthState}, got ${callbackResult.state}`)
            return { status: "error", message: "Invalid callback state" }
        }
        
        consola.debug(`[Auth] Session ${sessionId}: Exchanging code for token...`)
        const tokens = await exchangeCode(callbackResult.code, session.redirectUri)
        consola.debug(`[Auth] Session ${sessionId}: Fetching user info...`)
        const userInfo = await fetchUserInfo(tokens.accessToken)
        consola.debug(`[Auth] Session ${sessionId}: Fetching project ID...`)
        const projectId = await getProjectID(tokens.accessToken) || generateMockProjectId()

        // 添加到多账号管理器
        const account = {
            id: userInfo.email,
            email: userInfo.email,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: Date.now() + tokens.expiresIn * 1000,
            projectId,
        }
        accountManager.addAccount(account)

        consola.success(`✓ Antigravity account added: ${userInfo.email}`)
        return {
            status: "success",
            message: `Connected: ${userInfo.email}`,
            account: { id: userInfo.email, email: userInfo.email },
        }
    } catch (error: any) {
        consola.error(`[Auth] Session ${sessionId}: Error during final processing: ${error.message}`)
        return { status: "error", message: error.message || "Failed to finalize login" }
    }
}


/**
 * 刷新 access token
 */
export async function refreshToken(): Promise<boolean> {
    if (!state.refreshToken) {
        return false
    }

    try {
        const tokens = await refreshAccessToken(state.refreshToken)
        state.accessToken = tokens.accessToken
        state.antigravityToken = tokens.accessToken
        saveAuth()
        consola.success("Token refreshed successfully")
        return true
    } catch (error) {
        consola.error("Token refresh failed:", error)
        return false
    }
}
