#!/usr/bin/env bun
/**
 * Helper script to add additional Google accounts for quota rotation
 */

import consola from "consola"
import open from "open"
import { generateState, generateAuthURL, exchangeCode, fetchUserInfo, getProjectID, startOAuthCallbackServer } from "./src/services/antigravity/oauth"
import { accountManager } from "./src/services/antigravity/account-manager"
import * as fs from "fs"
import * as path from "path"

// Load existing accounts
accountManager.load()

consola.info("Current accounts:", accountManager.getEmails())
consola.info("Adding a new Google account for quota rotation...")

// Start OAuth callback server
const { server, port, waitForCallback } = await startOAuthCallbackServer()
const redirectUri = `http://localhost:${port}/oauth-callback`

// Generate auth URL
const state = generateState()
const authUrl = generateAuthURL(redirectUri, state)

consola.info("\nOpening browser for Google login...")
consola.info("If the browser doesn't open, visit this URL:\n")
consola.info(authUrl + "\n")

try {
    await open(authUrl)
} catch (e) {
    consola.warn("Failed to open browser automatically. Please open the URL manually.")
}

// Wait for callback
consola.info("Waiting for authentication...")
const result = await waitForCallback()
server.stop()

if (result.error) {
    consola.error("OAuth error:", result.error)
    process.exit(1)
}

if (!result.code || !result.state) {
    consola.error("Invalid callback parameters")
    process.exit(1)
}

if (result.state !== state) {
    consola.error("State mismatch - possible CSRF attack")
    process.exit(1)
}

// Exchange code for tokens
consola.info("Exchanging authorization code for tokens...")
const tokens = await exchangeCode(result.code, redirectUri)

// Get user info
consola.info("Fetching user information...")
const userInfo = await fetchUserInfo(tokens.accessToken)

// Get project ID
consola.info("Fetching project ID...")
const projectId = await getProjectID(tokens.accessToken)

if (!projectId) {
    consola.warn("Failed to get project ID - account may not have Antigravity enabled")
}

// Add account to manager
const accountId = userInfo.email
accountManager.addAccount({
    id: accountId,
    email: userInfo.email,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    projectId,
})

consola.success("\n✅ Account added successfully!")
consola.info("Email:", userInfo.email)
consola.info("Project ID:", projectId || "none")
consola.info("\nTotal accounts:", accountManager.count())
consola.info("All accounts:", accountManager.getEmails())

consola.box("Account rotation is now enabled!\nThe API will automatically switch between accounts when quota is exhausted.")
