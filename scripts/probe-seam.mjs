/**
 * The seam, measured rather than read.
 *
 * The README claims two things about
 * `packages/interaction/user-approval/src/index.ts`:
 *
 * 1. an **untagged** listener is admitted for every dispatch, and one carrying a
 *    scope tag is admitted only for that scope's own agent and its ancestors —
 *    never a sibling, and never a descendant; and
 * 2. `{ prepend: true }` is what puts a listener **ahead of** the application's
 *    own forwarder, without which a plugin registered later is never entered.
 *
 * Both are properties of the harness, so neither can be asserted from this
 * package's own source. This script registers exactly those listeners against
 * the **published** packages and prints what actually happens. It is
 * development-only, is not part of `npm test`, and is not published.
 *
 * ```sh
 * npm run probe:seam
 * ```
 *
 * @module scripts/probe-seam
 */

import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope, isScopeCarrier, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'

/** An agent with a real session — the approval service reads the session's policy. */
function agent(id) {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  return { id, session }
}

/** A context with the real approval service mounted. */
async function world() {
  const ctx = new Context()
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  return ctx
}

/** One request, in the shape the service dispatches. */
const request = who => ({ agent: who, toolName: 'bash', callId: 'c1', reason: 'probe' })

/** A forwarder shaped like `packages/api/remotes`': it answers, so nothing after it runs. */
const forwarder = (log) => { log.push('forwarder'); return Promise.resolve('unavailable') }

console.log('scopeOf(root ctx) =', scopeOf(await world()))

// 1. Untagged + prepend: reached, and the chain's own answer is what comes back.
{
  const ctx = await world()
  const who = agent('a')
  let fired = 0
  ctx.on('approval/request', async (req, next) => { fired += 1; return next() }, { prepend: true })
  const outcome = await ctx.approval.request(request(who))
  assert.equal(fired, 1)
  assert.equal(outcome, 'unavailable')
  console.log(`1. untagged + prepend          fired=${fired} outcome=${outcome}`)
}

// 2. The forwarder registered FIRST (as the application does), the bridge after:
//    prepend puts the bridge ahead of it — this is the seam.
{
  const ctx = await world()
  const log = []
  ctx.on('approval/request', () => forwarder(log))
  ctx.on('approval/request', async (req, next) => { log.push('bridge'); return next() }, { prepend: true })
  await ctx.approval.request(request(agent('a')))
  assert.deepEqual(log, ['bridge', 'forwarder'])
  console.log(`2. with prepend               order=${JSON.stringify(log)}`)
}

// 3. The same listener WITHOUT prepend is registered after the forwarder and is
//    never entered — the defect this package exists to close, reproduced.
{
  const ctx = await world()
  const log = []
  ctx.on('approval/request', () => forwarder(log))
  ctx.on('approval/request', async (req, next) => { log.push('bridge'); return next() })
  await ctx.approval.request(request(agent('a')))
  assert.deepEqual(log, ['forwarder'])
  console.log(`3. without prepend            order=${JSON.stringify(log)}  (the bridge is never reached)`)
}

// 4. A listener on the asking agent's OWN scope is admitted for it.
{
  const ctx = await world()
  const who = agent('a')
  const scoped = createScope(ctx, who)
  let fired = 0
  scoped.ctx.on('approval/request', async (req, next) => { fired += 1; return next() }, { prepend: true })
  await ctx.approval.request(request(who))
  await scoped.dispose()
  assert.equal(fired, 1)
  console.log(`4. scoped, same agent         fired=${fired}`)
}

// 5. …and the same listener on a SIBLING's scope sees nothing — silently.
{
  const ctx = await world()
  const mine = agent('mine')
  const sibling = createScope(ctx, agent('sibling'))
  let fired = 0
  sibling.ctx.on('approval/request', async (req, next) => { fired += 1; return next() }, { prepend: true })
  await ctx.approval.request(request(mine))
  await sibling.dispose()
  assert.equal(fired, 0)
  console.log(`5. scoped, sibling agent      fired=${fired}  (filtered out, and nothing is logged)`)
}

// 6. The untagged test is on `scopeOf`, not on the carrier: the carrier that
//    `scopeTarget` builds is a carrier for everyone, the root context is tagged
//    for no one.
{
  const ctx = await world()
  const carrier = scopeTarget(agent('a'), agent('a'))
  assert.equal(isScopeCarrier(carrier), true)
  assert.equal(scopeOf(ctx), undefined)
  console.log(`6. isScopeCarrier(carrier)=${isScopeCarrier(carrier)}  scopeOf(root)=${scopeOf(ctx)}`)
}

console.log('\nall six arms hold against the published line')
