import consola from "consola"
import { createHash, randomBytes } from "node:crypto"
import { authStore } from "~/services/auth/store"
import type { ProviderAccount } from "~/services/auth/types"

const CODEX_AUTH_FILE = "~/.codex/auth.json"

const CODEX_OAUTH_CONFIG = {
    clientId: process.env.CODEX_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann",
    clientSecret: process.env.CODEX_CLIENT_SECRET || "",
    authorizeUrl: "https://auth.openai.com/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scopes: ["openid", "profile", "email", "offline_access"],
    audience: "https://api.openai.com/v1",
    callbackPort: 51222,
}

type CodexTokens = {
    accessToken: string
    refreshToken?: string
    expiresIn?: number
    idToken?: string
}

type CodexCallbackResult = {
    code?: string
    state?: string
    error?: string
    redirectUri?: string
}

type CodexOAuthSession = {
    state: string
    authUrl: string
    fallbackUrl?: string
    redirectUri: string
    expiresAt: number
    callback?: CodexCallbackResult
    server: any
    codeVerifier?: string
}

let activeSession: CodexOAuthSession | null = null
let callbackServer: any | null = null

function decodeJwt(token: string): Record<string, any> | null {
    const parts = token.split(".")
    if (parts.length < 2) return null
    const payload = parts[1]
    const padded = payload.padEnd(payload.length + (4 - payload.length % 4) % 4, "=")
    try {
        const decoded = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
        return JSON.parse(decoded)
    } catch {
        return null
    }
}

function isJwtExpired(token: string): boolean {
    const claims = decodeJwt(token)
    if (!claims || typeof claims.exp !== "number") {
        return false
    }
    const expMs = claims.exp * 1000
    return expMs <= Date.now() + 60_000
}

function openBrowser(url: string): void {
    const platform = process.platform
    let cmd = "xdg-open"
    let args = [url]
    if (platform === "darwin") {
        cmd = "open"
    } else if (platform === "win32") {
        cmd = "cmd"
        args = ["/c", "start", url]
    }
    Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore" })
}

export async function importCodexAuthFile(): Promise<ProviderAccount | null> {
    const expandedPath = CODEX_AUTH_FILE.replace(/^~\//, `${process.env.HOME || process.env.USERPROFILE || ""}/`)
    try {
        const raw = JSON.parse(await Bun.file(expandedPath).text()) as any
        const tokens = raw.tokens || {}
        let accessToken = tokens.access_token || tokens.accessToken
        const refreshToken = tokens.refresh_token || tokens.refreshToken
        if (!accessToken && !refreshToken) {
            return null
        }

        const idToken = tokens.id_token || tokens.idToken
        const claims = idToken ? decodeJwt(idToken) : null
        if (accessToken && isJwtExpired(accessToken) && refreshToken) {
            try {
                const refreshed = await refreshCodexAccessToken(refreshToken)
                accessToken = refreshed.accessToken
            } catch (error) {
                consola.warn("Codex refresh failed during import:", error)
                return null
            }
        }
        if (!accessToken) {
            return null
        }
        const email = claims?.email
        const accountId = tokens.account_id || tokens.accountId || email || `codex-${Date.now()}`

        const account: ProviderAccount = {
            id: accountId,
            provider: "codex",
            email,
            accessToken,
            refreshToken,
            label: email || "Codex Account",
        }

        authStore.saveAccount(account)
        return account
    } catch (error) {
        consola.warn("Codex auth file import failed:", error)
        return null
    }
}

export function startCodexOAuthSession(): { state: string; authUrl: string; fallbackUrl?: string; expiresAt: number } {
    if (activeSession && Date.now() < activeSession.expiresAt) {
        return {
            state: activeSession.state,
            authUrl: activeSession.authUrl,
            fallbackUrl: activeSession.fallbackUrl,
            expiresAt: activeSession.expiresAt,
        }
    }

    callbackServer = ensureCodexCallbackServer()

    const state = crypto.randomUUID()
    const redirectUri = `http://localhost:${CODEX_OAUTH_CONFIG.callbackPort}/oauth-callback`
    const params = new URLSearchParams({
        client_id: CODEX_OAUTH_CONFIG.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: CODEX_OAUTH_CONFIG.scopes.join(" "),
        state,
        audience: CODEX_OAUTH_CONFIG.audience,
        prompt: "consent",
    })

    const codeVerifier = CODEX_OAUTH_CONFIG.clientSecret ? undefined : generateCodeVerifier()
    if (codeVerifier) {
        params.set("code_challenge", generateCodeChallenge(codeVerifier))
        params.set("code_challenge_method", "S256")
    }

    const authUrl = `${CODEX_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`
    params.delete("audience")
    const fallbackRedirectUri = `http://127.0.0.1:${CODEX_OAUTH_CONFIG.callbackPort}/oauth-callback`
    params.set("redirect_uri", fallbackRedirectUri)
    const fallbackUrl = `${CODEX_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`
    activeSession = {
        state,
        authUrl,
        redirectUri,
        expiresAt: Date.now() + 5 * 60 * 1000,
        server: callbackServer,
        codeVerifier,
        fallbackUrl,
    }

    return { state, authUrl, fallbackUrl, expiresAt: activeSession.expiresAt }
}

export async function pollCodexOAuthSession(state: string): Promise<{
    status: "pending" | "success" | "error"
    message?: string
    account?: ProviderAccount
}> {
    if (!activeSession || activeSession.state !== state) {
        return { status: "error", message: "No active Codex session" }
    }

    if (Date.now() > activeSession.expiresAt) {
        activeSession = null
        return { status: "error", message: "Codex OAuth session expired" }
    }

    if (!activeSession.callback) {
        return { status: "pending" }
    }

    const callback = activeSession.callback
    if (callback.error) {
        activeSession = null
        return { status: "error", message: callback.error }
    }

    if (!callback.code || callback.state !== state) {
        return { status: "error", message: "Invalid OAuth callback" }
    }

    const redirectUri = callback.redirectUri || activeSession.redirectUri
    const tokenResponse = await exchangeCodexCode(callback.code, redirectUri, activeSession.codeVerifier)
    const claims = tokenResponse.idToken ? decodeJwt(tokenResponse.idToken) : null
    const email = claims?.email
    const accountId = claims?.sub || email || `codex-${Date.now()}`

    const account: ProviderAccount = {
        id: accountId,
        provider: "codex",
        email,
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken,
        expiresAt: tokenResponse.expiresIn ? Date.now() + tokenResponse.expiresIn * 1000 : undefined,
        label: email || "Codex Account",
    }

    authStore.saveAccount(account)
    activeSession = null

    return { status: "success", account }
}

export async function startCodexOAuthLogin(): Promise<ProviderAccount> {
    const state = crypto.randomUUID()
    const redirectUri = `http://localhost:${CODEX_OAUTH_CONFIG.callbackPort}/oauth-callback`

    const params = new URLSearchParams({
        client_id: CODEX_OAUTH_CONFIG.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: CODEX_OAUTH_CONFIG.scopes.join(" "),
        state,
        audience: CODEX_OAUTH_CONFIG.audience,
        prompt: "consent",
    })

    const codeVerifier = CODEX_OAUTH_CONFIG.clientSecret ? undefined : generateCodeVerifier()
    if (codeVerifier) {
        params.set("code_challenge", generateCodeChallenge(codeVerifier))
        params.set("code_challenge_method", "S256")
    }

    const authUrl = `${CODEX_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`

    const { server, waitForCallback } = await startOAuthCallbackServer(CODEX_OAUTH_CONFIG.callbackPort)
    consola.info("Codex OAuth callback server started")

    openBrowser(authUrl)

    const result = await waitForCallback()
    server.stop()

    if (result.error) {
        throw new Error(result.error)
    }
    if (!result.code || result.state !== state) {
        throw new Error("Invalid OAuth callback state")
    }

    const effectiveRedirect = result.redirectUri || redirectUri
    const tokenResponse = await exchangeCodexCode(result.code, effectiveRedirect, codeVerifier)
    const claims = tokenResponse.idToken ? decodeJwt(tokenResponse.idToken) : null
    const email = claims?.email
    const accountId = claims?.sub || email || `codex-${Date.now()}`

    const account: ProviderAccount = {
        id: accountId,
        provider: "codex",
        email,
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken,
        expiresAt: tokenResponse.expiresIn ? Date.now() + tokenResponse.expiresIn * 1000 : undefined,
        label: email || "Codex Account",
    }

    authStore.saveAccount(account)
    return account
}

async function exchangeCodexCode(code: string, redirectUri: string, codeVerifier?: string): Promise<CodexTokens> {
    const params = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CODEX_OAUTH_CONFIG.clientId,
        code,
        redirect_uri: redirectUri,
    })
    if (CODEX_OAUTH_CONFIG.clientSecret) {
        params.set("client_secret", CODEX_OAUTH_CONFIG.clientSecret)
    }
    if (codeVerifier) {
        params.set("code_verifier", codeVerifier)
    }

    const response = await fetch(CODEX_OAUTH_CONFIG.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
    })

    const data = await response.json() as any
    if (!response.ok) {
        throw new Error(data?.error_description || data?.error || "Codex token exchange failed")
    }

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        idToken: data.id_token,
    }
}

function generateCodeVerifier(): string {
    return base64Url(randomBytes(32))
}

function generateCodeChallenge(verifier: string): string {
    return base64Url(createHash("sha256").update(verifier).digest())
}

function base64Url(buffer: Buffer): string {
    return buffer
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
}

export async function refreshCodexAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn?: number }> {
    const params = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CODEX_OAUTH_CONFIG.clientId,
        refresh_token: refreshToken,
    })

    const response = await fetch(CODEX_OAUTH_CONFIG.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
    })

    const data = await response.json() as any
    if (!response.ok) {
        throw new Error(data?.error_description || data?.error || "Codex token refresh failed")
    }

    return {
        accessToken: data.access_token,
        expiresIn: data.expires_in,
    }
}

function startCodexCallbackServer(
    port: number,
    onResult: (result: CodexCallbackResult) => void
): any {
    return Bun.serve({
        port,
        fetch(req) {
            const url = new URL(req.url)
            if (url.pathname === "/oauth-callback") {
                const code = url.searchParams.get("code")
                const state = url.searchParams.get("state")
                const error = url.searchParams.get("error")
                const redirectUri = `${url.origin}${url.pathname}`
                onResult({
                    code: code || undefined,
                    state: state || undefined,
                    error: error || undefined,
                    redirectUri,
                })
                return new Response(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>Codex OAuth</title>
                        <style>
                            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #000; color: #fff; }
                            h1 { font-size: 42px; }
                        </style>
                    </head>
                    <body>
                        <h1>Codex Connected</h1>
                        <p>You can close this window.</p>
                    </body>
                    </html>
                `, { headers: { "Content-Type": "text/html" } })
            }
            return new Response("Not Found", { status: 404 })
        },
    })
}

function ensureCodexCallbackServer(): any {
    if (callbackServer) {
        return callbackServer
    }
    try {
        callbackServer = startCodexCallbackServer(CODEX_OAUTH_CONFIG.callbackPort, (result) => {
            if (activeSession && activeSession.state === result.state) {
                activeSession.callback = result
            }
        })
        return callbackServer
    } catch (error) {
        throw new Error(`Codex callback port ${CODEX_OAUTH_CONFIG.callbackPort} is in use.`)
    }
}

async function startOAuthCallbackServer(port: number): Promise<{
    server: any
    waitForCallback: () => Promise<{ code?: string; state?: string; error?: string; redirectUri?: string }>
}> {
    let callbackResolve: ((result: { code?: string; state?: string; error?: string; redirectUri?: string }) => void) | null = null
    const callbackPromise = new Promise<{ code?: string; state?: string; error?: string; redirectUri?: string }>((res) => {
        callbackResolve = res
    })

    const server = startCodexCallbackServer(port, (result) => {
        if (callbackResolve) {
            callbackResolve(result)
        }
    })

    return {
        server,
        waitForCallback: () => callbackPromise,
    }
}
