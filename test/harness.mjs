/**
 * The integration harness: a REAL cordis context, the REAL scope primitive from
 * `@deepseek-ai/dsh-scope`, and the REAL `ToolRuntime` from `@deepseek-ai/dsh-tools`.
 *
 * The dispatch is not a simulation of the harness's. It is the expression the
 * approval service itself runs, quoted from
 * `packages/interaction/user-approval/src/index.ts`:
 *
 * ```js
 * this.ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req,
 *   () => Promise.resolve<ApprovalOutcome>('unavailable'))
 * ```
 *
 * so the two seam properties under test — the scope filter on the dispatch target,
 * and the position of a `{ prepend: true }` listener relative to a listener
 * registered earlier — are decided by the shipped `scopeTarget` and the shipped
 * dispatcher, not by anything this file arranges.
 *
 * `forwarder` is the stand-in for the application's own browser forwarder
 * (`packages/api/remotes`, `{ event: 'approval/request', mode: 'waterfall' }`). It
 * is registered **before** the plugin, exactly as the application registers it
 * before a later-mounted plugin, and it counts its own entries: that counter is how
 * "the bridge answered" is told apart from "the bridge answered *ahead of the
 * application's own surface*".
 *
 * @module test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'

/** The neutral cancellation signal every fabricated request carries. */
export const SIGNAL = new AbortController().signal

/** One asking agent stand-in; only `id` is read by the plugin. */
export const AGENT = { id: 'session-a' }

/** The exported module, as a loader would normalise it (`exports.default ?? exports`). */
export function moduleFor(mount = 'namespace') {
  return mount === 'default' ? plugin.default : plugin
}

/**
 * Mount a real context with a real tool registry, and by default this plugin.
 *
 * @param spec - `plugin: false` mounts everything except this plugin (the control
 *   arm); `mount` selects the namespace export or its `default`; `config` is the
 *   plugin's configuration; `forwarder: false` mounts no stand-in host forwarder,
 *   which models a composition whose own surface is absent; `hostOutcome` is what
 *   the forwarder answers (default: delegate to `next()`); `mountUnder` mounts the
 *   plugin on a fresh scope with that key instead of at the root.
 * @returns the context, the log, the forwarder counter, and any minted scope.
 */
export async function world(spec = {}) {
  const ctx = new Context({})
  const logged = []
  ctx.logger.exporter({ levels: { default: 2 }, export: message => { logged.push(message) } })

  // ToolRuntime injects `systemPrompt`; without it the service never starts and
  // `ctx.tools` stays undefined.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  const forwarder = { entered: 0, requests: [] }
  if (spec.forwarder !== false) {
    ctx.on('approval/request', async (req, next) => {
      forwarder.entered += 1
      forwarder.requests.push({ toolName: req.toolName, callId: req.callId })
      // The delay is what makes "the chain was entered immediately" observable:
      // a stand-in that answers instantly cannot tell a race from a sequence.
      if (spec.forwarderDelay !== undefined) await sleep(spec.forwarderDelay)
      if (spec.hostOutcome === undefined) return next()
      return spec.hostOutcome
    })
  }

  let scope
  if (spec.mountUnder !== undefined) {
    scope = createScope(ctx, spec.mountUnder, spec.mountUnderParent === undefined ? {} : { parent: spec.mountUnderParent })
    if (spec.plugin !== false) await scope.ctx.plugin(moduleFor(spec.mount), spec.config ?? {})
  } else if (spec.plugin !== false) {
    await ctx.plugin(moduleFor(spec.mount), spec.config ?? {})
  }

  return { ctx, logged, forwarder, scope }
}

/**
 * Dispatch one approval request exactly as the approval service does.
 *
 * @param ctx - the context to dispatch from.
 * @param spec - `agent` (default {@link AGENT}), `key` for the dispatch target's
 *   scope (default: unscoped), and the request's own fields.
 * @returns the settled outcome.
 */
export function dispatch(ctx, spec = {}) {
  const agent = spec.agent ?? AGENT
  const req = {
    agent,
    toolName: spec.toolName ?? 'bash',
    ...spec.callId === undefined ? {} : { callId: spec.callId },
    ...spec.reason === undefined ? {} : { reason: spec.reason },
    ...spec.signal === undefined ? {} : { signal: spec.signal },
  }
  return ctx.waterfall(
    scopeTarget(agent, spec.key),
    'approval/request',
    req,
    () => Promise.resolve('unavailable'),
  )
}

/**
 * Read the report tool through the real registry.
 *
 * `ctx.get('tools')` rather than `ctx.tools`: a property read of a service needs
 * the reading context to declare it in `inject`, and this harness reads the report
 * from whichever context the bridge was mounted on.
 * @param ctx - the context to read through.
 * @returns the report text.
 */
export async function report(ctx) {
  const result = await ctx.get('tools').execute({
    signal: SIGNAL,
    callId: 'call-report',
    name: 'approval_bridge_report',
    arguments: {},
    agent: AGENT,
  })
  return (result.content ?? []).map(block => block.type === 'text' ? block.text : '').join('\n')
}

/** The captured log as one string. */
export function logText(logged) {
  return logged.map(message => message.args.map(argument => String(argument)).join(' ')).join('\n')
}

/** Wait for a real timer, so "entered immediately" is a measurable fact. */
export function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}
