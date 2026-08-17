// src/utils/retry.ts

export interface RetryOptions {
  maxAttempts?: number       // default 3
  backoffMs?: number[]       // default [1000, 2000, 4000]
  shouldRetry?: (error: unknown) => boolean
}

const DEFAULT_BACKOFF = [1000, 2000, 4000]

/** Check if an error is transient (timeout, connection reset, 429, 5xx) */
export function isTransientError(error: unknown): boolean {
  if (error == null) return false

  const err = error as { code?: string; status?: number; statusCode?: number; message?: string }

  // Network-level errors
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'ECONNABORTED') {
    return true
  }

  // HTTP status-based errors
  const status = err.status ?? err.statusCode
  if (typeof status === 'number') {
    return status === 429 || (status >= 500 && status <= 599)
  }

  // Check message as last resort
  const msg = err.message?.toLowerCase() ?? ''
  if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('rate limit') || msg.includes('429') || msg.includes('503') || msg.includes('502')) {
    return true
  }

  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Retry a function with exponential backoff.
 * Only retries transient errors by default.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3
  const backoff = opts?.backoffMs ?? DEFAULT_BACKOFF
  const shouldRetry = opts?.shouldRetry ?? isTransientError

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt >= maxAttempts || !shouldRetry(error)) {
        throw error
      }
      const delay = backoff[Math.min(attempt - 1, backoff.length - 1)]
      await sleep(delay)
    }
  }
  throw lastError // unreachable, but satisfies TypeScript
}
