/**
 * The integration suite: the shipped dispatcher, the shipped scope filter, and
 * the shipped tool registry.
 *
 * Every arm here is about a claim the README makes, and every one of them is
 * paired with a control that shows the claim is about *this plugin* rather than
 * about the harness. The two that matter most:
 *
 * - `{ prepend: true }` is the only position ahead of a listener registered
 *   earlier — both directions are measured, so "the bridge answered first" cannot
 *   be an artefact of the arm.
 * - with nothing registered, the listener returns exactly what the chain would
 *   have produced. A plugin that changes the outcome of an unconfigured
 *   deployment is worse than no plugin.
 *
 * @module test/mount.spec
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createScope } from '@deepseek-ai/dsh-scope'
import { dispatch, logText, report, sleep, world } from './harness.mjs'


test('ordering, both directions: prepend is ahead of a listener registered earlier', async () => {
  // The application's own forwarder answers first, so a listener registered
  // afterwards without `prepend` is never entered. This is the defect.
  const late = await world({ plugin: false, hostOutcome: 'allowed-once' })
  let reachedWithoutPrepend = 0
  late.ctx.on('approval/request', async () => { reachedWithoutPrepend += 1; return 'rejected' })
  assert.equal(await dispatch(late.ctx), 'allowed-once')
  assert.equal(reachedWithoutPrepend, 0)
  assert.equal(late.forwarder.entered, 1)

  // The same listener with `prepend` decides the request instead.
  const early = await world({ plugin: false, hostOutcome: 'allowed-once' })
  early.ctx.on('approval/request', async () => 'rejected', { prepend: true })
  assert.equal(await dispatch(early.ctx), 'rejected')
  assert.equal(early.forwarder.entered, 0)
})

test('an untagged bridge is admitted for a scoped dispatch, and answers ahead of the forwarder', async () => {
  const key = {}
  const harness = await world({ config: { hostChain: 'defer' } })
  harness.ctx.approvalBridge.register({ name: 'phone', answer: () => 'allowed-once' })
  assert.equal(await dispatch(harness.ctx, { key, agent: { id: 'some-other-agent' } }), 'allowed-once')
  // `defer` asks the answerer first, so the forwarder is never entered: the
  // dispatch reached an untagged listener despite carrying another agent's scope.
  assert.equal(harness.forwarder.entered, 0)
})

test('a bridge mounted under a sibling scope is filtered out, and the report says so', async () => {
  const mine = {}
  const other = {}
  const harness = await world({ mountUnder: other })
  harness.ctx.approvalBridge.register({ name: 'phone', answer: () => 'allowed-once' })
  assert.equal(await dispatch(harness.ctx, { key: mine }), 'unavailable')
  assert.equal(harness.forwarder.entered, 1)
  // The service is reachable from every context, so the admission evidence is
  // readable wherever the mount put the bridge; the *report tool* follows the
  // harness's rule for a registration made through a scope-tagged context, which
  // is one more reason the recommended posture is the profile root.
  const snapshot = harness.ctx.approvalBridge.snapshot()
  assert.equal(snapshot.dispatched, 0)
  const text = harness.ctx.approvalBridge.report()
  assert.match(text, /requests this listener saw: 0/)
  assert.match(text, /IS scope-tagged/)
})

test('a bridge mounted at an ancestor scope is admitted for a descendant dispatch', async () => {
  const parent = {}
  const child = {}
  const harness = await world({ mountUnder: parent, config: { hostChain: 'defer' } })
  // The child scope is bound under the parent, so a listener owned by the parent
  // is an ancestor of the dispatching agent's scope.
  createScope(harness.ctx, child, { parent })
  harness.ctx.approvalBridge.register({ name: 'phone', answer: () => 'allowed-once' })
  assert.equal(await dispatch(harness.ctx, { key: child, agent: { id: 'child-agent' } }), 'allowed-once')
  assert.equal(harness.forwarder.entered, 0)
})

test('with nothing registered the bridge is a pass-through', async () => {
  for (const hostOutcome of ['allowed-once', 'rejected', 'cancelled']) {
    const bridged = await world({ hostOutcome })
    const plain = await world({ plugin: false, hostOutcome })
    assert.equal(await dispatch(bridged.ctx), hostOutcome)
    assert.equal(await dispatch(plain.ctx), hostOutcome)
    assert.equal(bridged.forwarder.entered, plain.forwarder.entered)
  }
  // And with no answerer anywhere on the chain, the harness's own fail-closed
  // value comes back unchanged.
  const bare = await world({ forwarder: false })
  assert.equal(await dispatch(bare.ctx), 'unavailable')
})

test('the default export mounts the same way the namespace does', async () => {
  const namespaced = await world({ mount: 'namespace' })
  const defaulted = await world({ mount: 'default' })
  for (const harness of [namespaced, defaulted]) {
    harness.ctx.approvalBridge.register({ name: 'phone', answer: () => 'allowed-once' })
    assert.equal(await dispatch(harness.ctx), 'allowed-once')
  }
})

test('an abstention does not end the exchange, whichever order it settles in', async () => {
  for (const order of ['silent-first', 'phone-first']) {
    const harness = await world({ config: { hostChain: 'defer' } })
    const silent = { name: 'silent', answer: () => undefined }
    const phone = { name: 'phone', answer: () => 'allowed-once' }
    for (const answerer of order === 'silent-first' ? [silent, phone] : [phone, silent]) {
      harness.ctx.approvalBridge.register(answerer)
    }
    assert.equal(await dispatch(harness.ctx), 'allowed-once')
    assert.equal(harness.forwarder.entered, 0)
  }
})

test("an answerer's 'unavailable' is an abstention, not a decision", async () => {
  const harness = await world({ hostOutcome: 'allowed-once' })
  harness.ctx.approvalBridge.register({ name: 'shrug', answer: () => 'unavailable' })
  assert.equal(await dispatch(harness.ctx), 'allowed-once')
  assert.equal(harness.forwarder.entered, 1)
  // Asked, and counted as an abstention the answerer *chose* — not as a bug.
  // The distinction is the whole vocabulary: a plugin that produced
  // `'unavailable'` by accident is reported, and one that produced it on purpose
  // is not.
  const text = await report(harness.ctx)
  assert.match(text, /#0 shrug — calls 1, claims 0, abstains 1, errors 0/)
})

test('a throwing answerer abstains: it cannot fail an approval open, and it is reported', async () => {
  // The host chain answers `rejected` on purpose: a bridge that turned a
  // throwing answerer into a grant would be indistinguishable from one that
  // abstained if both settled on the same outcome.
  const harness = await world({ hostOutcome: 'rejected' })
  harness.ctx.approvalBridge.register({ name: 'broken', answer: () => { throw new Error('boom') } })
  assert.equal(await dispatch(harness.ctx), 'rejected')
  const text = await report(harness.ctx)
  assert.match(text, /#0 broken/)
  assert.match(text, /errors 1/)
  assert.match(text, /last error: Error: boom/)
})

test('a non-vocabulary return is an abstention the answerer did not choose, and it is reported', async () => {
  const harness = await world({ hostOutcome: 'allowed-once' })
  harness.ctx.approvalBridge.register({ name: 'typo', answer: () => 'allow' })
  assert.equal(await dispatch(harness.ctx), 'allowed-once')
  const text = await report(harness.ctx)
  assert.match(text, /not an approval outcome: "allow"/)
})

test('a throwing match filter silences that surface, and says so', async () => {
  const harness = await world({ hostOutcome: 'allowed-once' })
  harness.ctx.approvalBridge.register({
    name: 'bad-filter',
    match: () => { throw new Error('nope') },
    answer: () => 'rejected',
  })
  assert.equal(await dispatch(harness.ctx), 'allowed-once')
  const text = await report(harness.ctx)
  assert.match(text, /#0 bad-filter filtered/)
  assert.match(text, /calls 0/)
  assert.match(text, /errors 1/)
})

test('a match filter that excludes a tool is never asked about it', async () => {
  let asked = 0
  const harness = await world({})
  harness.ctx.approvalBridge.register({
    name: 'phone',
    match: ask => ask.toolName === 'bash',
    answer: () => { asked += 1; return 'allowed-once' },
  })
  assert.equal(await dispatch(harness.ctx, { toolName: 'read' }), 'unavailable')
  assert.equal(asked, 0)
  assert.equal(await dispatch(harness.ctx, { toolName: 'bash' }), 'allowed-once')
  assert.equal(asked, 1)
})

test('defer: the host chain is entered only when every answerer abstains', async () => {
  const answered = await world({ config: { hostChain: 'defer' }, hostOutcome: 'allowed-once' })
  answered.ctx.approvalBridge.register({ name: 'phone', answer: () => 'rejected' })
  assert.equal(await dispatch(answered.ctx), 'rejected')
  assert.equal(answered.forwarder.entered, 0)

  const abstained = await world({ config: { hostChain: 'defer' }, hostOutcome: 'allowed-once' })
  abstained.ctx.approvalBridge.register({ name: 'phone', answer: () => undefined })
  assert.equal(await dispatch(abstained.ctx), 'allowed-once')
  assert.equal(abstained.forwarder.entered, 1)
})

test('race: the host chain is entered immediately, and whichever participant claims first wins', async () => {
  const fastBridge = await world({ config: { hostChain: 'race' }, hostOutcome: 'allowed-once', forwarderDelay: 20 })
  fastBridge.ctx.approvalBridge.register({ name: 'phone', answer: () => 'rejected' })
  assert.equal(await dispatch(fastBridge.ctx), 'rejected')
  // Entered at once and still counting, even though its answer arrived second.
  assert.equal(fastBridge.forwarder.entered, 1)

  const slowBridge = await world({ config: { hostChain: 'race' }, hostOutcome: 'allowed-once' })
  slowBridge.ctx.approvalBridge.register({
    name: 'phone',
    answer: async () => { await sleep(20); return 'rejected' },
  })
  assert.equal(await dispatch(slowBridge.ctx), 'allowed-once')
  assert.equal(slowBridge.forwarder.entered, 1)
})

test('observe: nothing is decided, the answerer is not called, and the request is still counted', async () => {
  let called = 0
  const harness = await world({ config: { mode: 'observe' } })
  harness.ctx.approvalBridge.register({ name: 'phone', answer: () => { called += 1; return 'rejected' } })
  assert.equal(await dispatch(harness.ctx), 'unavailable')
  assert.equal(called, 0)
  assert.equal(harness.forwarder.entered, 1)
  const text = await report(harness.ctx)
  assert.match(text, /requests this listener saw: 1/)
  assert.match(text, /posture "observe"/)
})

test('off: no listener is mounted, and the report says so', async () => {
  const harness = await world({ config: { mode: 'off' } })
  harness.ctx.approvalBridge.register({ name: 'phone', answer: () => 'allowed-once' })
  assert.equal(await dispatch(harness.ctx), 'unavailable')
  assert.equal(harness.forwarder.entered, 1)
  const text = await report(harness.ctx)
  assert.match(text, /posture "off": no listener is mounted/)
  assert.match(text, /requests this listener saw: 0/)
})

test('unregistering retires the surface and keeps its counters', async () => {
  const harness = await world({})
  const off = harness.ctx.approvalBridge.register({ name: 'phone', answer: () => 'allowed-once' })
  assert.equal(await dispatch(harness.ctx), 'allowed-once')
  off()
  off() // idempotent
  assert.equal(await dispatch(harness.ctx), 'unavailable')
  const text = await report(harness.ctx)
  assert.match(text, /#0 phone \(unregistered\)/)
  assert.match(text, /calls 1, claims 1/)
  assert.match(text, /requests this listener saw: 2/)
})

test('the report answers the admission question, through the real registry', async () => {
  const harness = await world({})
  harness.ctx.approvalBridge.register({
    name: 'phone',
    match: ask => ask.toolName === 'bash',
    answer: () => undefined,
  })
  assert.equal(await dispatch(harness.ctx, { toolName: 'bash', callId: 'call-1' }), 'unavailable')
  assert.equal(await dispatch(harness.ctx, { toolName: 'read', reason: 'why not' }), 'unavailable')
  const text = await report(harness.ctx)
  assert.match(text, /^# approval-bridge report/m)
  assert.match(text, /mode: bridge \(host chain: race\)/)
  assert.match(text, /requests this listener saw: 2/)
  assert.match(text, /matching at least one answerer: 1/)
  assert.match(text, /left to the host chain: 2/)
  assert.match(text, /tool=bash call=call-1 agent=session-a matched=\[phone\] winner=\(host chain\) -> unavailable/)
  assert.match(text, /tool=read agent=session-a matched=\[none\]/)
})

test('a bridge mounted where nothing asks says so, and names the reason it cannot know', async () => {
  const harness = await world({ forwarder: false })
  const text = await report(harness.ctx)
  assert.match(text, /requests this listener saw: 0/)
  assert.match(text, /No request has reached this listener/)
  assert.match(text, /never a descendant, and never a sibling/)
})

test('an unknown configuration value is reported rather than silently honoured', async () => {
  const harness = await world({ config: { mode: 'bridgey', hostChain: 'later' } })
  assert.equal(await dispatch(harness.ctx), 'unavailable')
  const text = logText(harness.logged)
  assert.match(text, /ignoring unknown configuration value\(s\) mode \(bridgey\), hostChain \(later\)/)
  assert.match(text, /using mode "bridge" with host chain "race"/)
})

test('mounting below a scope warns, and the warning names the consequence', async () => {
  const harness = await world({ mountUnder: {} })
  const text = logText(harness.logged)
  assert.match(text, /mounted on a scope-tagged context/)
  assert.match(text, /Mount the bridge at the profile \(root\) level/)
})

test('the report tool is registered by default and absent when it is switched off', async () => {
  const on = await world({})
  assert.equal(on.ctx.tools.get('approval_bridge_report')?.name, 'approval_bridge_report')
  const off = await world({ config: { report: false } })
  assert.equal(off.ctx.tools.get('approval_bridge_report'), undefined)
  // The bridge itself is unaffected by that switch.
  off.ctx.approvalBridge.register({ name: 'phone', answer: () => 'allowed-once' })
  assert.equal(await dispatch(off.ctx), 'allowed-once')
})

test('the plugin works with no tool registry mounted at all', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: plugin } = await import('../lib/index.js')
  const bare = new Context({})
  await bare.plugin(plugin, {})
  bare.approvalBridge.register({ name: 'phone', answer: () => 'allowed-once' })
  assert.equal(await dispatch(bare), 'allowed-once')
  assert.match(bare.approvalBridge.report(), /requests this listener saw: 1/)
})
