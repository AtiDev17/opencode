/**
 * Process-local live provider status for sessions.
 *
 * The runner records an entry whenever a session schedules a provider retry
 * (`SessionRunnerRetry.wait`, alongside the durable `RetryScheduled` event) and
 * clears it when the agent loop makes forward progress again (step completed,
 * compaction/overflow recovered) or the session is interrupted/removed.
 *
 * Scope: the runner and the HTTP server share one process (`serve --service`),
 * so a plain module singleton is the right store — no DB writes, no
 * cross-process concerns, no Effect layer plumbing. Read back through the
 * `@opencode/core/session/live-status` export by the
 * `GET /api/session/:sessionID/status` handler.
 */

import type { SessionError } from "@opencode/schema/session-error"
import type { SessionSchema } from "./schema.js"

export interface SessionLiveStatus {
  /** A provider retry is scheduled and the session is sleeping toward it. */
  readonly retrying: boolean
  /** The current/last retry cause is a provider rate limit. */
  readonly rateLimited: boolean
  /** Retry attempt number (>= 2 once any retry is scheduled). */
  readonly attempt: number
  /** Epoch milliseconds when the retry fires. */
  readonly retryAt: number
  /** Typed session error tag, e.g. "provider.rate-limit". */
  readonly lastErrorType: string
  readonly lastError: string
  /** Epoch milliseconds when this retry was scheduled. */
  readonly updatedAt: number
}

const store = new Map<SessionSchema.ID, SessionLiveStatus>()

export const SessionLiveStatus = {
  /** Record a scheduled retry. Called from the runner's retry wait, alongside RetryScheduled. */
  recordRetry(
    sessionID: SessionSchema.ID,
    input: { readonly attempt: number; readonly retryAt: number; readonly error: SessionError.Error },
  ) {
    store.set(sessionID, {
      retrying: true,
      rateLimited: input.error.type === "provider.rate-limit",
      attempt: input.attempt,
      retryAt: input.retryAt,
      lastErrorType: input.error.type,
      lastError: input.error.message,
      updatedAt: Date.now(),
    })
  },

  /** Clear the retry record (step progress, interrupt, or session removal). */
  clear(sessionID: SessionSchema.ID) {
    store.delete(sessionID)
  },

  get(sessionID: SessionSchema.ID): SessionLiveStatus | undefined {
    return store.get(sessionID)
  },
}