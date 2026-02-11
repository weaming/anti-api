/**
 * Token 后台刷新服务
 * 定期检查并刷新即将过期的 token，避免请求时才发现过期
 */

import consola from "consola"
import { accountManager } from "./account-manager"
import { refreshAccessToken, getProjectID } from "./oauth"
import { authStore } from "../auth/store"

export class TokenRefreshService {
    private intervalId: NodeJS.Timeout | null = null
    private isRunning = false
    
    /**
     * Token 提前刷新时间（默认 10 分钟）
     */
    private readonly REFRESH_BUFFER_MS = 10 * 60 * 1000
    
    /**
     * 检查间隔（默认 5 分钟）
     */
    private readonly CHECK_INTERVAL_MS = 5 * 60 * 1000

    /**
     * 启动后台刷新服务
     */
    start(): void {
        if (this.isRunning) {
            consola.warn("Token refresh service already running")
            return
        }

        consola.info("Starting token refresh service...")
        this.isRunning = true
        
        // 立即执行一次检查
        this.checkAndRefreshTokens().catch(err => {
            consola.error("Initial token refresh check failed:", err)
        })
        
        // 定期检查
        this.intervalId = setInterval(() => {
            this.checkAndRefreshTokens().catch(err => {
                consola.error("Token refresh check failed:", err)
            })
        }, this.CHECK_INTERVAL_MS)
    }

    /**
     * 停止后台刷新服务
     */
    stop(): void {
        if (!this.isRunning) {
            return
        }

        consola.info("Stopping token refresh service...")
        this.isRunning = false
        
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }
    }

    /**
     * 检查并刷新即将过期的 token
     */
    private async checkAndRefreshTokens(): Promise<void> {
        accountManager.load()
        const accountIds = accountManager.listAccounts()
        
        if (accountIds.length === 0) {
            return
        }

        const now = Date.now()
        const refreshThreshold = now + this.REFRESH_BUFFER_MS
        
        let refreshedCount = 0
        let failedCount = 0

        for (const accountId of accountIds) {
            try {
                // 直接访问内部账号数据以获取完整信息
                const fullAccount = accountManager["accounts"].get(accountId)
                if (!fullAccount) {
                    continue
                }

                // 检查是否需要刷新
                const needsRefresh = fullAccount.expiresAt > 0 && fullAccount.expiresAt < refreshThreshold
                
                if (!needsRefresh) {
                    continue
                }

                consola.debug(`Refreshing token for account: ${fullAccount.email}`)
                
                // 尝试刷新 token
                const result = await this.refreshAccountToken(accountId, fullAccount.refreshToken)
                
                if (result.success) {
                    refreshedCount++
                    consola.info(`✓ Token refreshed for ${fullAccount.email}`)
                } else {
                    failedCount++
                    consola.warn(`✗ Token refresh failed for ${fullAccount.email}: ${result.error}`)
                }
            } catch (error) {
                failedCount++
                consola.error(`Error checking account ${accountId}:`, error)
            }
        }

        if (refreshedCount > 0 || failedCount > 0) {
            consola.info(`Token refresh summary: ${refreshedCount} succeeded, ${failedCount} failed`)
        }
    }

    /**
     * 刷新单个账号的 token
     */
    private async refreshAccountToken(accountId: string, refreshToken: string): Promise<{ success: boolean; error?: string }> {
        try {
            // 尝试刷新 token（最多重试 3 次）
            let lastError: Error | null = null
            
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const tokens = await refreshAccessToken(refreshToken)
                    const now = Date.now()
                    
                    // 更新账号信息
                    const updatedAccount = accountManager["accounts"].get(accountId)
                    if (updatedAccount) {
                        updatedAccount.accessToken = tokens.accessToken
                        updatedAccount.expiresAt = now + tokens.expiresIn * 1000
                        
                        // 同时刷新 projectId（如果缺失）
                        if (!updatedAccount.projectId) {
                            try {
                                updatedAccount.projectId = await getProjectID(tokens.accessToken)
                            } catch (e) {
                                consola.debug("Failed to fetch project ID during refresh:", e)
                            }
                        }
                        
                        // 保存到持久化存储
                        accountManager.save()
                        authStore.saveAccount({
                            id: updatedAccount.id,
                            provider: "antigravity",
                            email: updatedAccount.email,
                            accessToken: updatedAccount.accessToken,
                            refreshToken: updatedAccount.refreshToken,
                            expiresAt: updatedAccount.expiresAt,
                            projectId: updatedAccount.projectId || undefined,
                            label: updatedAccount.email,
                        })
                    }
                    
                    return { success: true }
                } catch (error) {
                    lastError = error as Error
                    
                    if (attempt < 2) {
                        // 等待后重试（指数退避）
                        const delayMs = 1000 * Math.pow(2, attempt)
                        await new Promise(resolve => setTimeout(resolve, delayMs))
                    }
                }
            }
            
            return { 
                success: false, 
                error: lastError?.message || "Unknown error" 
            }
        } catch (error) {
            return { 
                success: false, 
                error: (error as Error).message 
            }
        }
    }
}

// 全局单例
export const tokenRefreshService = new TokenRefreshService()
