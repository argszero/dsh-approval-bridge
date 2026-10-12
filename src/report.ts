/**
 * The one place a deployment can read back whether the bridge is where it thinks
 * it is, and what it has been doing.
 *
 * The reason this plugin ships a report at all is the asymmetry it exists to
 * close: the harness logs **nothing** when a scope filter excludes a listener, so
 * a plugin author who registers an approval listener and never sees a request has
 * no way to tell "my listener is not admitted" from "no approval was ever
 * requested". The dispatch counter is that answer, and it is only trustworthy
 * because it is the listener's own count.
 *
 * @module @argszero/dsh-approval-bridge/report
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from './ask.ts'
import { OUTCOMES } from './ask.ts'
import type { Ledger, Snapshot } from './ledger.ts'
import type { Settings } from './config.ts'

/** The tool name the report is read with. */
export const REPORT_TOOL = 'approval_bridge_report'

/** What the report needs to know about the mount, beyond the counters. */
export interface MountFacts {
  readonly settings: Settings
  /**
   * Whether this listener's own context carries no scope tag, and is therefore
   * admitted for every agent's requests. See {@link renderReport} for why this is
   * reported as a fact rather than a promise.
   */
  readonly untagged: boolean
  /**
   * One entry per declared answerer slot, in declaration order — the same order
   * as the ledger's own tally, so the two are read side by side by index.
   */
  readonly answerers: readonly { readonly name: string; readonly filtered: boolean; readonly retired: boolean }[]
}

/** Bound one line of text. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** One outcome tally as `name count` pairs, zeros included. */
function tallyLine(tally: Readonly<Record<ApprovalOutcome, number>>): string {
  return OUTCOMES.map(outcome => `${outcome} ${tally[outcome]}`).join(', ')
}

/**
 * The read-only report.
 * @param snapshot - the ledger's counters.
 * @param facts - the mount's posture and registry.
 * @returns the report text.
 */
export function renderReport(snapshot: Snapshot, facts: MountFacts): string {
  const { settings } = facts
  const lines: string[] = []
  lines.push('# approval-bridge report', '')
  lines.push(`mode: ${settings.mode} (host chain: ${settings.hostChain})`)
  lines.push(facts.untagged
    ? 'admission: this listener\'s context carries no scope tag, so it is admitted for every agent\'s requests.'
    : 'admission: this listener\'s context IS scope-tagged, so the harness admits it only for that scope\'s own '
      + 'agents and their descendants — every other agent\'s requests are filtered out silently. Mount the bridge '
      + 'at the profile (root) level to see them all.')
  lines.push('')
  lines.push(`requests this listener saw: ${snapshot.dispatched}`)
  lines.push(`  matching at least one answerer: ${snapshot.matched}`)
  lines.push(`  claimed by an answerer: ${snapshot.claimed}`)
  lines.push(`  left to the host chain: ${snapshot.delegated}`)
  lines.push(`outcomes returned: ${tallyLine(snapshot.outcomes)}`)

  if (settings.mode === 'observe') {
    lines.push('')
    lines.push('posture "observe": every request above was delegated — this plugin decided nothing.')
  }
  if (settings.mode === 'off') {
    lines.push('')
    lines.push('posture "off": no listener is mounted, so every counter above is zero by construction.')
  }

  lines.push('', '## answerers')
  if (snapshot.answerers.length === 0) {
    lines.push('(none registered — the bridge is a pass-through: every request goes to the host chain unchanged)')
  } else {
    for (const [index, answerer] of snapshot.answerers.entries()) {
      const known = facts.answerers[index]
      const filter = known?.filtered === true ? ' filtered' : ''
      const retired = known?.retired === true ? ' (unregistered)' : ''
      lines.push(`  #${index} ${answerer.name}${filter}${retired} — calls ${answerer.calls}, claims ${answerer.claims}, `
        + `abstains ${answerer.abstains}, errors ${answerer.errors}`)
      if (answerer.lastError !== undefined) lines.push(`      last error: ${clip(answerer.lastError, 300)}`)
    }
    lines.push('')
    lines.push('(calls counts the requests an answerer was asked to decide — its own `match` filter runs first, so a')
    lines.push(' filtered answerer is never called for a tool it excluded)')
  }

  lines.push('', `## the ${snapshot.retained.length} most recent request${snapshot.retained.length === 1 ? '' : 's'}`)
  if (snapshot.retained.length === 0) {
    lines.push('(none)')
  } else {
    for (const entry of snapshot.retained) lines.push(entryLine(entry))
    if (snapshot.dropped > 0) lines.push(`(and ${snapshot.dropped} older request(s) dropped from this list; the counters keep the totals)`)
  }

  if (snapshot.dispatched === 0 && settings.mode !== 'off') {
    lines.push('')
    lines.push('No request has reached this listener. If approvals have certainly been asked in this deployment, this')
    lines.push('is the answer to "why does my listener never fire": the harness\'s scope filter skipped it, and it logs')
    lines.push('nothing when it does. A listener is admitted when its context is untagged (every request) or when its')
    lines.push('tag is the dispatched agent or one of that agent\'s ancestors — never a descendant, and never a sibling.')
  }
  return lines.join('\n')
}

/** One retained request as a line. */
function entryLine(entry: Snapshot['retained'][number]): string {
  const call = entry.callId === undefined ? '' : ` call=${entry.callId}`
  const agent = entry.agentId === undefined ? '' : ` agent=${entry.agentId}`
  const winner = entry.winner === undefined ? '(host chain)' : entry.winner
  const matched = entry.matched.length === 0 ? 'none' : entry.matched.join('+')
  return `- ${entry.at} tool=${entry.toolName}${call}${agent} matched=[${matched}] winner=${winner} -> ${entry.outcome}`
}

/**
 * The read-only report tool.
 *
 * `mount` is a thunk rather than a value: answerers register and unregister
 * while the report exists, and a report on a stale registry would list
 * surfaces that are no longer mounted.
 * @param ledger - the counters to read.
 * @param mount - reads the mount's posture and current registry.
 * @returns the tool definition.
 */
export function reportTool(ledger: Ledger, mount: () => MountFacts) {
  return defineTool({
    name: REPORT_TOOL,
    description: 'Report whether @argszero/dsh-approval-bridge is reached by the harness\'s approval requests at all, '
      + 'how many it saw, how many a registered answerer claimed, and what each answerer did — the admission evidence '
      + 'the harness does not log. Reads counters and changes nothing.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return renderReport(ledger.snapshot(), mount())
    },
  })
}
