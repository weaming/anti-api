/**
 * Anti-API 错误处理
 */

import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import consola from "consola"

export class HTTPError extends Error {
    response: Response

    constructor(message: string, response: Response) {
        super(message)
        this.response = response
    }
}

export class AntigravityError extends Error {
    code: string

    constructor(message: string, code: string = "antigravity_error") {
        super(message)
        this.code = code
    }
}

export class UpstreamError extends Error {
    status: number
    provider: string
    body: string
    retryAfter?: string

    constructor(provider: string, status: number, body: string, retryAfter?: string) {
        super(`${provider} upstream error (${status})`)
        this.status = status
        this.provider = provider
        this.body = body
        this.retryAfter = retryAfter
    }
}

/**
 * 转发错误到客户端
 */
export async function forwardError(c: Context, error: unknown) {
    consola.error("Error occurred:", error)

    if (error instanceof HTTPError) {
        const errorText = await error.response.text()
        let errorJson: unknown
        try {
            errorJson = JSON.parse(errorText)
        } catch {
            errorJson = errorText
        }
        consola.error("HTTP error:", errorJson)
        return c.json(
            {
                error: {
                    type: "error",
                    message: errorText,
                },
            },
            error.response.status as ContentfulStatusCode,
        )
    }

    if (error instanceof AntigravityError) {
        return c.json(
            {
                error: {
                    type: error.code,
                    message: error.message,
                },
            },
            500,
        )
    }

    if (error instanceof UpstreamError) {
        return c.json(
            {
                error: {
                    type: "upstream_error",
                    message: error.body || error.message,
                    provider: error.provider,
                },
            },
            error.status as ContentfulStatusCode,
        )
    }

    return c.json(
        {
            error: {
                type: "error",
                message: (error as Error).message,
            },
        },
        500,
    )
}
