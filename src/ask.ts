/**
 * The shapes an answerer sees, and the closed vocabulary it may answer with.
 *
 * The vocabulary is the approval service's own (`allowed-once`, `rejected`,
 * `cancelled`, `unavailable`) and is restated here as a literal list rather than
 * imported as a value: importing it would make this plugin and the harness share
 * a mutable module, and the only thing this plugin needs from that module is the
 * set of four strings, which is the smallest possible contract.
 *
 * @module @argszero/dsh-approval-bridge/ask
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * One pending decision, as an answerer receives it.
 *
 * Structurally the harness's own `ApprovalRequestEvent`, deliberately restated
 * (this plugin imports only its *type*) so an answerer never has to build the
 * harness's package graph to be written.
 */
export interface ApprovalAsk {
  /** The agent whose call is waiting — which session, hence which conversation. */
  readonly agent: Agent
  /** The tool whose operation needs the decision. */
  readonly toolName: string
  /** The exact tool call, when the asker had one. */
  readonly callId?: string
  /** The asker's human-readable reason (e.g. an escalation's justification). */
  readonly reason?: string
  /** Localized presentation text, when the asker supplied it. */
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  /** The cancellation lifetime of the pending request; never invented by this plugin. */
  readonly signal?: AbortSignal
}

/**
 * What an answerer returns.
 *
 * `undefined` and `null` mean "no answer" and are the same thing as
 * `'unavailable'`: an answerer asks to be passed over, and the arbitration moves
 * on. There is deliberately **no** way for an answerer to *claim* a request with
 * `'unavailable'` — that value is the harness's own fail-closed answer for "no
 * answerer exists", and letting a plugin produce it would be indistinguishable,
 * to the asker, from having no approval channel at all.
 */
export type ApprovalAnswer = ApprovalOutcome | undefined | null

/** The harness's closed approval vocabulary. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Every {@link ApprovalOutcome}, for runtime normalization of answerer returns. */
export const OUTCOMES: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/** The outcomes that settle a request — everything except the fail-closed non-answer. */
export const CLAIMING: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled']

/** Whether a value claims the request, i.e. is a decision rather than an abstention. */
export function isClaiming(value: unknown): value is ApprovalOutcome {
  return typeof value === 'string' && (CLAIMING as readonly string[]).includes(value)
}

/** One registered answerer. */
export interface ApprovalAnswerer {
  /**
   * The name this answerer is reported under. Defaults to its registration
   * index; give it one, because the report is how a deployment tells two
   * surfaces apart.
   */
  readonly name?: string
  /**
   * Whether this answerer wants the request at all. Omit to see every request.
   * An answerer that returns false is not called, so a surface can stay silent
   * on tools it does not present without paying for the call.
   */
  readonly match?: (ask: ApprovalAsk) => boolean
  /**
   * Answer the request. Return a claiming outcome to decide it, or an
   * abstention (`undefined`/`null`/`'unavailable'`) to leave it to the others.
   * A throw is contained and reported as an abstention: no answerer's bug can
   * fail an approval open.
   */
  readonly answer: (ask: ApprovalAsk) => ApprovalAnswer | Promise<ApprovalAnswer>
}
