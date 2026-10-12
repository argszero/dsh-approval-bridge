/**
 * A third-party surface can never receive an approval card — and the harness logs
 * nothing when *that* is the reason.
 *
 * ## The defect
 *
 * `approval/request` is a scope-filtered waterfall
 * (`packages/interaction/user-approval/src/index.ts`):
 *
 * ```js
 * this.ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req,
 *   () => Promise.resolve<ApprovalOutcome>('unavailable'))
 * ```
 *
 * Two properties of that one line decide whether a plugin's listener is ever
 * reached, and neither of them produces a log line when it is not:
 *
 * 1. **The dispatch is filtered.** A listener registered on a context that
 *    carries a scope tag is admitted only for that scope's own agent and for
 *    that agent's *ancestors*; every other agent's request is filtered out
 *    silently. `@deepseek-ai/dsh-scope` states the direction: "A tag BELOW the
 *    dispatch key stays excluded — events flow up the chain, never down."
 * 2. **Registration order decides first refusal.** The application's own
 *    forwarder to the browser is registered on the profile context
 *    (`packages/api/remotes`, `{ event: 'approval/request', mode: 'waterfall' }`).
 *    A listener registered *after* it — the normal case for a plugin mounted
 *    later — is never called, because the forwarder already returned an outcome.
 *
 * So a third-party surface (a phone, an IM bot, a watch, a voice channel) cannot
 * be reached at all, and a plugin author who registers an `approval/request`
 * listener and watches it never fire cannot tell "I am not admitted" from
 * "nobody ever asked".
 *
 * ## The seam
 *
 * Both halves close with one listener registered with `{ prepend: true }` on an
 * **untagged** context:
 *
 * - untagged ⇒ `scopeOf(ctx) === undefined`, and `scopeTarget`'s filter admits
 *   untagged listeners for every dispatch; and
 * - `prepend` ⇒ it is entered before the application's own forwarder.
 *
 * Both were measured against the published line rather than read off the source:
 * a probe that registers exactly that listener observes a real approval request
 * that the host chain leaves unanswered (`fired=1`), a listener registered
 * without `prepend` is entered *after* the forwarder (order `['bridge',
 * 'forwarder']`), and a listener registered on a sibling agent scope is admitted
 * for its own scope only.
 *
 * ## What this plugin does
 *
 * It registers that one listener and turns it into a registry: a deployment
 * plugin calls {@link ApprovalBridge.register} with an answerer, and the bridge
 * arbitrates every registered answerer against the host chain — the first
 * *claiming* outcome wins, abstentions are left to the others, a throwing
 * answerer is contained as an abstention so no answerer's bug can fail an
 * approval **open**, and with nothing registered the listener is a pass-through
 * that returns exactly the outcome the chain would have produced without it.
 *
 * It also answers the question the harness cannot: the dispatch counter is the
 * denominator that separates "my listener is not admitted" from "no approval was
 * ever requested", and `approval_bridge_report` prints it together with the
 * scope tag the filter actually reads.
 *
 * ## What this plugin cannot do
 *
 * - It cannot make a *tagged* listener admitted. Scope filtering is the
 *   dispatcher's, and mounting the bridge below an agent scope narrows what it
 *   sees; the report names that posture instead of hiding it.
 * - It cannot withdraw a card the host chain already drew. Under the default
 *   `race` posture the host chain is started immediately, so a deployment where
 *   two surfaces are online at once may see the bridge win while the other
 *   surface's prompt is still on screen. `defer` is the posture that never
 *   draws the host card, at the price of the answerer's own latency.
 * - It cannot answer anything itself. Whether a surface may grant a permission
 *   is a deployment's policy; this plugin supplies the seam, the arbitration and
 *   the audit, and nothing that decides policy on its own — an answerer that
 *   would grant must be written and mounted by whoever owns that decision.
 * - It cannot override the session's `'never'` policy: the approval service
 *   decides that *before* dispatching (`effectivePolicy(session) === 'never'`
 *   returns `'rejected'` without entering the waterfall), so a `never` session
 *   never reaches this listener at all.
 *
 * @module @argszero/dsh-approval-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { arbitrate } from './arbitrate.ts'
import { isClaiming } from './ask.ts'
import type { ApprovalAnswer, ApprovalAnswerer, ApprovalAsk } from './ask.ts'
import { normalizeConfig } from './config.ts'
import type { Config } from './config.ts'
import { agentIdOf, createLedger } from './ledger.ts'
import type { Ledger, Snapshot } from './ledger.ts'
import { renderReport, reportTool } from './report.ts'
import type { MountFacts } from './report.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'approval-bridge'

export { arbitrate } from './arbitrate.ts'
export { isClaiming, CLAIMING, OUTCOMES } from './ask.ts'
export type { ApprovalAnswer, ApprovalAnswerer, ApprovalAsk, ApprovalOutcome as ApprovalAnswerOutcome } from './ask.ts'
export { defaultConfig, normalizeConfig } from './config.ts'
export type { BridgeMode, Config, HostChainPolicy, Settings } from './config.ts'
export { agentIdOf, createLedger } from './ledger.ts'
export type { AnswererStats, Ledger, RequestRecord, Snapshot } from './ledger.ts'
export { REPORT_TOOL, renderReport } from './report.ts'
export type { MountFacts } from './report.ts'

/**
 * The API this plugin provides as `ctx.approvalBridge`.
 *
 * A deployment's own surface plugin injects this name and registers an
 * answerer; that is the whole integration. Registration is scoped to the
 * registering fiber when the returned disposer is handed to `ctx.effect`, which
 * is the shape the README shows.
 */
export interface ApprovalBridge {
  /**
   * Register one answerer. Registration order is the order answered in, and the
   * order the report lists.
   * @param answerer - the surface's match filter and answer function.
   * @returns an idempotent unregister; the counters keep the history.
   */
  register(answerer: ApprovalAnswerer): () => void
  /** The current counters, immutable and safe to keep. */
  snapshot(): Snapshot
  /** The same text the report tool returns. */
  report(): string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    approvalBridge: ApprovalBridge
  }
}

/** The decisions that settle a request — everything except the fail-closed non-answer. */
function claims(decision: Decision): boolean {
  return isClaiming(decision.outcome)
}

/** One answerer slot, indexed by the ledger slot it declared. */
interface Slot {
  readonly name: string
  readonly match: ((ask: ApprovalAsk) => boolean) | undefined
  readonly answer: (ask: ApprovalAsk) => ApprovalAnswer | Promise<ApprovalAnswer>
  readonly index: number
  /** Set when the registering plugin unregisters. The tally is kept. */
  retired: boolean
}

/** One participant's settled decision, or `undefined` for an abstention. */
interface Decision {
  readonly outcome: ApprovalOutcome
  readonly winner: string | undefined
}

/** A value rendered for a diagnostic line, without throwing on a circular one. */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Mount the bridge.
 * @param ctx - the context to mount on. Register on an untagged one (the
 * profile root) or the harness's scope filter will skip most requests.
 * @param config - the raw configuration, validated here.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const normalized = normalizeConfig(config)
  const settings = normalized.settings
  if (normalized.rejected.length > 0) {
    ctx.logger.warn(`approval-bridge: ignoring unknown configuration value(s) ${normalized.rejected.join(', ')}; `
      + `using mode "${settings.mode}" with host chain "${settings.hostChain}"`)
  }
  if (settings.mode === 'off') {
    ctx.logger.warn('approval-bridge: mode "off" — no listener is mounted; the report tool still answers, and says so')
  }

  const ledger: Ledger = createLedger(settings.maxReported)
  const slots: Slot[] = []
  const untagged = scopeOf(ctx) === undefined
  if (!untagged) {
    ctx.logger.warn('approval-bridge: mounted on a scope-tagged context, so the harness admits this listener only for '
      + 'that scope\'s own agents and their ancestors — every other agent\'s approval requests are filtered out with no '
      + 'log line. Mount the bridge at the profile (root) level to see them all.')
  }

  const mountFacts = (): MountFacts => ({
    settings,
    untagged,
    answerers: slots.map(slot => ({ name: slot.name, filtered: slot.match !== undefined, retired: slot.retired })),
  })

  const bridge: ApprovalBridge = {
    register(answerer) {
      const name = answerer.name ?? `#${slots.length}`
      // The ledger slot is the registration index, and it is never reused: a
      // re-registered surface keeps the counters its first registration earned.
      const index = ledger.declare(name)
      const slot: Slot = {
        name,
        match: answerer.match,
        answer: answerer.answer,
        index,
        retired: false,
      }
      slots[index] = slot
      return () => {
        slot.retired = true
      }
    },
    snapshot: () => ledger.snapshot(),
    report: () => renderReport(ledger.snapshot(), mountFacts()),
  }
  ctx.provide('approvalBridge', bridge)

  // The registry is asked for rather than required: a headless composition
  // without tools still gets the bridge, and the report is simply not reachable
  // there. It is registered in EVERY mode, `off` included — a posture whose whole
  // purpose is to report what it is not doing is the one that most needs a way to
  // be read.
  if (settings.report) {
    ctx.inject(['tools'], (child) => {
      child.tools.register(reportTool(ledger, mountFacts))
    })
  }

  if (settings.mode === 'off') return

  /**
   * Ask one answerer, containing everything it can do wrong.
   * @param slot - the slot to ask.
   * @param ask - the request as the answerer sees it.
   * @returns its decision, or `undefined` for an abstention.
   */
  const askOne = async (slot: Slot, ask: ApprovalAsk): Promise<Decision | undefined> => {
    ledger.called(slot.index)
    let value: unknown
    try {
      value = await slot.answer(ask)
    } catch (error: unknown) {
      // A throwing answerer is an abstention it did not choose. It must never
      // fail the request OPEN, and it must never be silent either — the report
      // carries the error.
      ledger.erroredBy(slot.index, error)
      return undefined
    }
    if (value === undefined || value === null || value === 'unavailable') {
      ledger.abstainedBy(slot.index)
      return undefined
    }
    if (isClaiming(value)) {
      ledger.claimedBy(slot.index, value)
      return { outcome: value, winner: slot.name }
    }
    // A non-vocabulary return is a bug in the answerer, not an abstention it
    // chose. Both leave the request to the others, but only one of them is
    // reported, and it is this one.
    ledger.erroredBy(slot.index, new Error(`not an approval outcome: ${describe(value)} (expected one of allowed-once, rejected, cancelled, unavailable)`))
    return undefined
  }

  /**
   * Run the answerers and the host chain per the configured posture.
   * @param matched - the slots whose `match` admitted this request.
   * @param ask - the request.
   * @param next - the remainder of the harness's own answerer chain.
   * @returns the settled decision.
   */
  const decide = async (
    matched: readonly Slot[],
    ask: ApprovalAsk,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<Decision> => {
    if (settings.hostChain === 'defer') {
      const held = await arbitrate(matched.map(slot => askOne(slot, ask)), claims)
      if (held !== undefined) return held
      return { outcome: await next(), winner: undefined }
    }
    // `race`: the host chain is entered immediately, so a request reaches the
    // harness's own surface at the moment it would have without this plugin.
    let hostOutcome: ApprovalOutcome | undefined
    const host = next().then((outcome) => {
      hostOutcome = outcome
      return isClaiming(outcome) ? { outcome, winner: undefined } satisfies Decision : undefined
    })
    const decided = await arbitrate([host, ...matched.map(slot => askOne(slot, ask))], claims)
    if (decided !== undefined) return decided
    // Every answerer abstained and the host chain produced its non-claiming
    // value — normally the fail-closed `'unavailable'`, and whatever it was,
    // it is what the request must settle on.
    return { outcome: hostOutcome ?? 'unavailable', winner: undefined }
  }

  ctx.effect(() => {
    const off = ctx.on('approval/request', async (req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> => {
      const ask: ApprovalAsk = req
      const matched: Slot[] = []
      for (const slot of slots) {
        if (slot.retired) continue
        if (slot.match === undefined) {
          matched.push(slot)
          continue
        }
        try {
          if (slot.match(ask)) matched.push(slot)
        } catch (error: unknown) {
          // The filter is not the answer: it is only consulted to decide whether
          // to ask. A filter that throws silences that surface, and says so.
          ledger.erroredBy(slot.index, error)
        }
      }

      const base = {
        at: new Date().toISOString(),
        toolName: req.toolName,
        matched: matched.map(slot => slot.name),
      }
      const callId = req.callId === undefined ? {} : { callId: String(req.callId) }
      const reason = req.reason === undefined ? {} : { reason: req.reason }
      const agentId = agentIdOf(ask)
      const agent = agentId === undefined ? {} : { agentId }

      let decision: Decision
      try {
        decision = settings.mode === 'observe'
          ? { outcome: await next(), winner: undefined }
          : await decide(matched, ask, next)
      } catch (error: unknown) {
        // Reachable only when the host chain itself throws under `defer`. The
        // harness turns that into the fail-closed outcome one level up, so the
        // ledger records what the request will settle on, not a guess.
        ledger.record({ ...base, ...callId, ...reason, ...agent, outcome: 'unavailable' })
        throw error
      }
      ledger.record({
        ...base,
        ...callId,
        ...reason,
        ...agent,
        ...decision.winner === undefined ? {} : { winner: decision.winner },
        outcome: decision.outcome,
      })
      return decision.outcome
    }, { prepend: true })

    return off
  }, `approval-bridge: arbitrate registered approval answerers ahead of the host chain (mode: ${settings.mode})`)
}

/**
 * The object a loader entry mounts: `vendor/loader` normalises a plugin module
 * with `exports.default ?? exports` and hands this to `ctx.plugin`, which reads
 * `Config['~standard'].validate` off it when it is present.
 *
 * No `Config` is exported on purpose. A plain defaults object in that position is
 * how a published plugin ends up mounting as `TypeError: Cannot read properties of
 * undefined (reading 'validate')`; the defaults reach a mount through
 * `apply(ctx, config = {})` instead.
 */
export default { name, apply }
