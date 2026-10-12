/**
 * The evidence the register cannot carry: what this listener was actually
 * reached by, and what it did with it.
 *
 * A scope-filtered listener is skipped with **no log line** — `scopeTarget`'s
 * filter returns false and the dispatch never mentions it. So "my approval
 * listener never fires" is a question a plugin author cannot answer from
 * outside, which is why the first counter here is the dispatch count itself: a
 * bridge mounted where its own scope admits it sees every request it is composed
 * for, and one mounted below an unrelated scope sees none — so the difference
 * between "never reached" and "reached and abstained" is this denominator, and
 * nothing else in the system produces it.
 *
 * @module @argszero/dsh-approval-bridge/ledger
 */

import type { ApprovalAsk, ApprovalOutcome } from './ask.ts'

/** What one answerer did, in aggregate. */
export interface AnswererStats {
  readonly name: string
  /** Requests this answerer was asked to decide. */
  readonly calls: number
  /** Of those, how many produced a claiming outcome. */
  readonly claims: number
  /** Of those, how many returned an abstention. */
  readonly abstains: number
  /** Of those, how many threw — contained and reported as an abstention. */
  readonly errors: number
  /** The last error's text, if any. */
  readonly lastError?: string
}

/** One request, as the retained tail keeps it. */
export interface RequestRecord {
  readonly at: string
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  /** The asking agent's id, when it has a printable one. */
  readonly agentId?: string
  /** The answerers that matched this request, in registration order. */
  readonly matched: readonly string[]
  /** The answerer that claimed it, or `undefined` when the host chain did. */
  readonly winner?: string
  /** What the listener returned. */
  readonly outcome: ApprovalOutcome
}

/** Everything the report can answer. */
export interface Snapshot {
  /** Requests this listener was admitted for — the admission denominator. */
  readonly dispatched: number
  /** Of those, how many at least one registered answerer claimed to handle. */
  readonly matched: number
  /** Requests decided by a registered answerer. */
  readonly claimed: number
  /** Requests passed to the host chain (no match, observe posture, or abstention). */
  readonly delegated: number
  /** How often each outcome was returned. */
  readonly outcomes: Readonly<Record<ApprovalOutcome, number>>
  /** Per-answerer counters, in registration order. */
  readonly answerers: readonly AnswererStats[]
  /** The retained request records, newest last. */
  readonly retained: readonly RequestRecord[]
  /** Records dropped because the retention bound was reached. */
  readonly dropped: number
}

/** The counter, and the single place that advances it. */
export interface Ledger {
  /** Declare one answerer; the returned handle is its slot in the report. */
  declare(name: string): number
  /** Count one call to one answerer. */
  called(index: number): void
  /** Count one claiming answer. */
  claimedBy(index: number, outcome: ApprovalOutcome): void
  /** Count one abstention. */
  abstainedBy(index: number): void
  /** Count one throw — an abstention the answerer did not choose. */
  erroredBy(index: number, error: unknown): void
  /** Record one request the listener saw and what it returned. */
  record(entry: RequestRecord): void
  /** The current counters. */
  snapshot(): Snapshot
}

const MUTABLE_OUTCOMES: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

interface Tally {
  name: string
  calls: number
  claims: number
  abstains: number
  errors: number
  lastError?: string
}

/**
 * Create the ledger.
 * @param bound - how many request records to retain; the counters are unbounded.
 * @returns the ledger.
 */
export function createLedger(bound: number): Ledger {
  const outcomes: Record<ApprovalOutcome, number> = { 'allowed-once': 0, rejected: 0, cancelled: 0, unavailable: 0 }
  const tallies: Tally[] = []
  const retained: RequestRecord[] = []
  let dispatched = 0
  let matched = 0
  let claimed = 0
  let delegated = 0
  let dropped = 0

  const at = (index: number): Tally => {
    const existing = tallies[index]
    if (existing !== undefined) return existing
    // Only a bug in this plugin can ask for a slot that was never declared, but
    // a report that throws is a report that answers nothing, so the slot is
    // created rather than asserted. The gap is filled in the same pass: the
    // report lists answerers by index, and a sparse array would make its own
    // listing skip exactly the slot it is reporting on.
    let created: Tally | undefined
    for (let cursor = tallies.length; cursor <= index; cursor += 1) {
      created = { name: `#${cursor}`, calls: 0, claims: 0, abstains: 0, errors: 0 }
      tallies[cursor] = created
    }
    return created ?? { name: `#${index}`, calls: 0, claims: 0, abstains: 0, errors: 0 }
  }

  return {
    declare(name) {
      tallies.push({ name, calls: 0, claims: 0, abstains: 0, errors: 0 })
      return tallies.length - 1
    },
    called(index) {
      at(index).calls += 1
    },
    claimedBy(index) {
      at(index).claims += 1
    },
    abstainedBy(index) {
      at(index).abstains += 1
    },
    erroredBy(index, error) {
      const tally = at(index)
      tally.errors += 1
      tally.lastError = String(error)
    },
    record(entry) {
      dispatched += 1
      if (entry.matched.length > 0) matched += 1
      outcomes[entry.outcome] += 1
      if (entry.winner === undefined) delegated += 1
      else claimed += 1
      retained.push(entry)
      // The tail is what a report is read from; the counters above are the
      // denominator and are never trimmed, so "nothing was dropped" stays
      // distinguishable from "everything was".
      const keep = Math.max(1, bound)
      while (retained.length > keep) {
        retained.shift()
        dropped += 1
      }
    },
    snapshot() {
      return {
        dispatched,
        matched,
        claimed,
        delegated,
        outcomes: Object.fromEntries(MUTABLE_OUTCOMES.map(key => [key, outcomes[key]])) as Record<ApprovalOutcome, number>,
        answerers: tallies.map(tally => (tally.lastError === undefined
          ? { name: tally.name, calls: tally.calls, claims: tally.claims, abstains: tally.abstains, errors: tally.errors }
          : { name: tally.name, calls: tally.calls, claims: tally.claims, abstains: tally.abstains, errors: tally.errors, lastError: tally.lastError })),
        retained: [...retained],
        dropped,
      }
    },
  }
}

/** The printable id of one ask's agent, when it has one. */
export function agentIdOf(ask: ApprovalAsk): string | undefined {
  const id = (ask.agent as { readonly id?: unknown } | undefined)?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}
