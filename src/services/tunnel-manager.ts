/**
 * 隧道管理服务
 * 支持 cloudflared, ngrok, localtunnel
 */

import { spawn, type ChildProcess } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import consola from "consola"

const CONFIG_FILE = join(process.cwd(), "data", "remote-config.json")

interface TunnelConfig {
    ngrokAuthtoken?: string
    localtunnelSubdomain?: string
}

interface TunnelState {
    process: ChildProcess | { pid: number; kill: () => void } | null
    url: string | null
}

export interface TunnelStatus {
    active: boolean
    url: string | null
    pid: number | null
    error?: string
    uptime?: number // seconds since start
    reconnectCount?: number
}

// 隧道状态
const tunnelState: Record<string, TunnelState> = {
    cloudflared: { process: null, url: null },
    ngrok: { process: null, url: null },
    localtunnel: { process: null, url: null },
}

// ngrok 稳定性增强状态
const ngrokStability = {
    startTime: null as number | null,
    healthCheckInterval: null as ReturnType<typeof setInterval> | null,
    reconnectCount: 0,
    maxReconnects: 3,
    lastPort: 44444,  // 🆕 修正为 anti-api 默认端口
    lastAuthtoken: null as string | null,
    isReconnecting: false,
}

/**
 * 加载配置
 */
function loadConfig(): TunnelConfig {
    try {
        if (existsSync(CONFIG_FILE)) {
            return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
        }
    } catch (e) { }
    return {}
}

/**
 * 保存配置
 */
function saveConfig(config: TunnelConfig): void {
    try {
        const dir = join(process.cwd(), "data")
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
        }
        writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
    } catch (e) {
        consola.error("Failed to save config:", e)
    }
}

/**
 * 获取所有隧道状态
 */
export function getAllTunnelStatus(): Record<string, TunnelStatus> {
    return {
        cloudflared: {
            active: !!tunnelState.cloudflared.process,
            url: tunnelState.cloudflared.url,
            pid: (tunnelState.cloudflared.process as any)?.pid || null,
        },
        ngrok: {
            active: !!tunnelState.ngrok.process,
            url: tunnelState.ngrok.url,
            pid: (tunnelState.ngrok.process as any)?.pid || null,
        },
        localtunnel: {
            active: !!tunnelState.localtunnel.process,
            url: tunnelState.localtunnel.url,
            pid: (tunnelState.localtunnel.process as any)?.pid || null,
        },
    }
}

/**
 * 获取保存的配置
 */
export function getSavedConfig(): TunnelConfig {
    return loadConfig()
}

/**
 * 启动 Cloudflared 隧道
 */
export async function startCloudflared(port: number): Promise<TunnelStatus> {
    if (tunnelState.cloudflared.process) {
        return { active: true, url: tunnelState.cloudflared.url, pid: (tunnelState.cloudflared.process as any).pid || null }
    }

    return new Promise((resolve) => {
        const proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"], {
            stdio: ["ignore", "pipe", "pipe"]
        })

        tunnelState.cloudflared.process = proc

        let resolved = false
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true
                resolve({ active: !!tunnelState.cloudflared.process, url: null, pid: proc.pid || null, error: "60秒超时，建议使用ngrok" })
            }
        }, 60000)

        const handleOutput = (data: Buffer) => {
            const output = data.toString()
            const urlMatch = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/)
            if (urlMatch && !resolved) {
                tunnelState.cloudflared.url = urlMatch[0]
                resolved = true
                clearTimeout(timeout)
                resolve({ active: true, url: urlMatch[0], pid: proc.pid || null })
            }
        }

        proc.stdout?.on("data", handleOutput)
        proc.stderr?.on("data", handleOutput)

        proc.on("close", () => {
            tunnelState.cloudflared.process = null
            tunnelState.cloudflared.url = null
            if (!resolved) {
                resolved = true
                clearTimeout(timeout)
                resolve({ active: false, url: null, pid: null, error: "进程退出" })
            }
        })

        proc.on("error", (err) => {
            tunnelState.cloudflared.process = null
            if (!resolved) {
                resolved = true
                clearTimeout(timeout)
                resolve({ active: false, url: null, pid: null, error: err.message })
            }
        })
    })
}

/**
 * 停止 Cloudflared 隧道
 */
export function stopCloudflared(): TunnelStatus {
    if (tunnelState.cloudflared.process) {
        (tunnelState.cloudflared.process as ChildProcess).kill?.()
        tunnelState.cloudflared.process = null
        tunnelState.cloudflared.url = null
    }
    return { active: false, url: null, pid: null }
}

/**
 * 启动 ngrok 隧道（带自动重连和健康检查）
 */
export async function startNgrok(port: number, authtoken?: string): Promise<TunnelStatus> {
    // 如果正在重连中，返回当前状态
    if (ngrokStability.isReconnecting) {
        return {
            active: false,
            url: null,
            pid: null,
            error: "Reconnecting...",
            reconnectCount: ngrokStability.reconnectCount
        }
    }

    if (tunnelState.ngrok.process) {
        const uptime = ngrokStability.startTime
            ? Math.floor((Date.now() - ngrokStability.startTime) / 1000)
            : 0
        return {
            active: true,
            url: tunnelState.ngrok.url,
            pid: (tunnelState.ngrok.process as any).pid || null,
            uptime,
            reconnectCount: ngrokStability.reconnectCount
        }
    }

    // 保存参数用于自动重连
    ngrokStability.lastPort = port
    if (authtoken) {
        ngrokStability.lastAuthtoken = authtoken
    }

    // Kill any existing ngrok processes first
    try {
        spawn("killall", ["ngrok"], { stdio: "ignore" })
        const findProc = spawn("lsof", ["-ti", ":4040"], { stdio: ["ignore", "pipe", "ignore"] })
        let pids = ""
        findProc.stdout?.on("data", (data) => { pids += data.toString() })
        await new Promise(resolve => findProc.on("close", resolve))
        for (const pid of pids.trim().split("\n").filter(Boolean)) {
            spawn("kill", ["-9", pid], { stdio: "ignore" })
        }
        await new Promise(resolve => setTimeout(resolve, 2000))
    } catch { }

    if (authtoken) {
        const config = loadConfig()
        config.ngrokAuthtoken = authtoken
        saveConfig(config)
    }

    const config = loadConfig()
    const token = authtoken || config.ngrokAuthtoken || ngrokStability.lastAuthtoken

    if (!token) {
        return { active: false, url: null, pid: null, error: "需要 authtoken，请在 Remote 页面输入" }
    }

    return new Promise(async (resolve) => {
        const args = ["http", port.toString(), "--authtoken", token, "--log", "stdout"]

        const proc = spawn("ngrok", args, {
            stdio: ["ignore", "pipe", "pipe"]
        })

        tunnelState.ngrok.process = proc
        ngrokStability.startTime = Date.now()

        let resolved = false  // 🆕 防止重复 resolve
        const safeResolve = (result: TunnelStatus) => {
            if (resolved) return
            resolved = true
            resolve(result)
        }

        let attempts = 0
        const maxAttempts = 10  // 🆕 减少到 10 次（20秒超时）

        const checkUrl = async () => {
            if (resolved) return  // 已经 resolve 就不再检查
            attempts++
            try {
                const apiRes = await fetch("http://localhost:4040/api/tunnels", { signal: AbortSignal.timeout(3000) })
                const data = await apiRes.json() as any
                const url = data.tunnels?.[0]?.public_url
                if (url) {
                    tunnelState.ngrok.url = url
                    consola.success("Ngrok URL:", url)

                    // 启动健康检查
                    startNgrokHealthCheck()

                    safeResolve({
                        active: true,
                        url,
                        pid: proc.pid || null,
                        uptime: 0,
                        reconnectCount: ngrokStability.reconnectCount
                    })
                    return
                }
            } catch (e) { }

            if (attempts < maxAttempts && !resolved) {
                setTimeout(checkUrl, 2000)
            } else if (!resolved) {
                consola.error("Failed to get ngrok URL after", maxAttempts, "attempts")
                safeResolve({
                    active: !!tunnelState.ngrok.process,
                    url: null,
                    pid: proc.pid || null,
                    error: "获取URL超时(20s)，请检查ngrok是否正常启动",
                    reconnectCount: ngrokStability.reconnectCount
                })
            }
        }

        setTimeout(checkUrl, 1500)  // 🆕 更快开始检查

        proc.on("close", (code) => {
            consola.warn(`Ngrok process exited with code ${code}`)
            tunnelState.ngrok.process = null
            tunnelState.ngrok.url = null
            stopNgrokHealthCheck()

            // 🆕 如果还没有 resolve，先 resolve 再重连
            if (!resolved) {
                safeResolve({ active: false, url: null, pid: null, error: `进程退出(code=${code})` })
            }

            // 自动重连
            attemptNgrokReconnect()
        })

        proc.on("error", (err) => {
            consola.error("Ngrok error:", err)
            tunnelState.ngrok.process = null
            stopNgrokHealthCheck()
            safeResolve({ active: false, url: null, pid: null, error: err.message })
        })
    })
}

/**
 * 启动 ngrok 健康检查（每 30 秒）
 */
function startNgrokHealthCheck() {
    stopNgrokHealthCheck()
    ngrokStability.healthCheckInterval = setInterval(async () => {
        if (!tunnelState.ngrok.process) return

        try {
            const apiRes = await fetch("http://localhost:4040/api/tunnels")
            const data = await apiRes.json() as any
            const url = data.tunnels?.[0]?.public_url

            if (!url) {
                consola.warn("Ngrok health check failed: no tunnel URL")
            } else if (url !== tunnelState.ngrok.url) {
                tunnelState.ngrok.url = url
            }
        } catch {
            consola.warn("Ngrok health check failed: API unreachable")
        }
    }, 30000)
}

/**
 * 停止健康检查
 */
function stopNgrokHealthCheck() {
    if (ngrokStability.healthCheckInterval) {
        clearInterval(ngrokStability.healthCheckInterval)
        ngrokStability.healthCheckInterval = null
    }
}

/**
 * 尝试自动重连
 */
async function attemptNgrokReconnect() {
    if (ngrokStability.isReconnecting) return
    if (ngrokStability.reconnectCount >= ngrokStability.maxReconnects) {
        consola.error(`Ngrok reached max reconnect attempts (${ngrokStability.maxReconnects})`)
        return
    }

    ngrokStability.isReconnecting = true
    ngrokStability.reconnectCount++

    consola.warn(`Ngrok auto-reconnect attempt ${ngrokStability.reconnectCount}/${ngrokStability.maxReconnects}...`)

    // 等待 5 秒后重连
    await new Promise(resolve => setTimeout(resolve, 5000))

    try {
        await startNgrok(ngrokStability.lastPort, ngrokStability.lastAuthtoken || undefined)
        consola.success("Ngrok reconnected successfully")
    } catch (e) {
        consola.error("Ngrok reconnect failed:", e)
    }

    ngrokStability.isReconnecting = false
}

/**
 * 停止 ngrok 隧道
 */
export function stopNgrok(): TunnelStatus {
    stopNgrokHealthCheck()
    ngrokStability.reconnectCount = 0
    ngrokStability.startTime = null
    ngrokStability.isReconnecting = false

    if (tunnelState.ngrok.process) {
        (tunnelState.ngrok.process as ChildProcess).kill?.()
        tunnelState.ngrok.process = null
        tunnelState.ngrok.url = null
    }
    return { active: false, url: null, pid: null }
}

/**
 * 启动 localtunnel 隧道
 */
export async function startLocaltunnel(port: number, subdomain?: string): Promise<TunnelStatus> {
    if (tunnelState.localtunnel.process) {
        return { active: true, url: tunnelState.localtunnel.url, pid: (tunnelState.localtunnel.process as any).pid || null }
    }

    if (subdomain) {
        const config = loadConfig()
        config.localtunnelSubdomain = subdomain
        saveConfig(config)
    }

    return new Promise(async (resolve) => {
        try {
            const localtunnel = (await import("localtunnel")).default
            const tunnelOptions: any = { port, host: "127.0.0.1", local_host: "127.0.0.1" }
            if (subdomain) {
                tunnelOptions.subdomain = subdomain
            }

            const tunnel = await localtunnel(tunnelOptions)

            tunnelState.localtunnel.process = {
                pid: process.pid,
                kill: () => tunnel.close(),
            } as any
            tunnelState.localtunnel.url = tunnel.url

            tunnel.on("close", () => {
                tunnelState.localtunnel.process = null
                tunnelState.localtunnel.url = null
            })

            tunnel.on("error", (err: any) => {
                consola.error("Localtunnel error:", err)
                tunnelState.localtunnel.process = null
                tunnelState.localtunnel.url = null
            })

            let password = ""
            try {
                const pwdRes = await fetch("https://loca.lt/mytunnelpassword")
                password = (await pwdRes.text()).trim()
            } catch (e) { }

            resolve({
                active: true,
                url: tunnel.url,
                pid: process.pid,
                error: password ? `密码: ${password}` : undefined
            })
        } catch (e: any) {
            consola.error("Failed to start localtunnel:", e)
            resolve({ active: false, url: null, pid: null, error: e.message })
        }
    })
}

/**
 * 停止 localtunnel 隧道
 */
export function stopLocaltunnel(): TunnelStatus {
    if (tunnelState.localtunnel.process) {
        tunnelState.localtunnel.process.kill()
        tunnelState.localtunnel.process = null
        tunnelState.localtunnel.url = null
    }
    return { active: false, url: null, pid: null }
}
