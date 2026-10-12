/**
 * Configuration and counter units: the shapes the report is read from, and the
 * two decisions that must never be silent — a misspelled option, and a record that
 * was dropped from the retained tail.
 *
 * @module test/config.spec
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentIdOf, createLedger, defaultConfig, normalizeConfig, renderReport } from '../lib/index.js'

test('defaults change nothing for a deployment that does not ask', () => {
  const { settings, rejected } = normalizeConfig()
  assert.deepEqual(settings, defaultConfig)
  assert.deepEqual(rejected, [])
  assert.equal(settings.mode, 'bridge')
  assert.equal(settings.hostChain, 'race')
  assert.equal(settings.report, true)
})

test('a misspelled option is reported and replaced, never silently honoured', () => {
  const { settings, rejected } = normalizeConfig({ mode: 'bridged', hostChain: 'deferred' })
  assert.deepEqual(rejected, ['mode (bridged)', 'hostChain (deferred)'])
  assert.equal(settings.mode, 'bridge')
  assert.equal(settings.hostChain, 'race')
})

test('every legal option is accepted as written', () => {
  for (const mode of ['bridge', 'observe', 'off']) {
    assert.deepEqual(normalizeConfig({ mode }).rejected, [])
  }
  for (const hostChain of ['race', 'defer']) {
    assert.deepEqual(normalizeConfig({ hostChain }).rejected, [])
  }
})

test('the retention bound is a positive integer or the default', () => {
  assert.equal(normalizeConfig({ maxReported: 3 }).settings.maxReported, 3)
  assert.equal(normalizeConfig({ maxReported: 0 }).settings.maxReported, 25)
  assert.equal(normalizeConfig({ maxReported: -1 }).settings.maxReported, 25)
  assert.equal(normalizeConfig({ maxReported: 2.7 }).settings.maxReported, 2)
  assert.equal(normalizeConfig({ maxReported: Number.NaN }).settings.maxReported, 25)
})

test('the ledger keeps the counters a dropped record would have carried', () => {
  const ledger = createLedger(2)
  const entry = index => ({
    at: `t${index}`,
    toolName: 'bash',
    matched: [],
    outcome: 'unavailable',
  })
  for (let index = 0; index < 4; index += 1) ledger.record(entry(index))
  const snapshot = ledger.snapshot()
  assert.equal(snapshot.dispatched, 4)
  assert.equal(snapshot.delegated, 4)
  assert.deepEqual(snapshot.retained.map(record => record.at), ['t2', 't3'])
  assert.equal(snapshot.dropped, 2)
})

test('the matched counter counts the requests an answerer claimed to handle, and not the others', () => {
  const ledger = createLedger(5)
  ledger.record({ at: 't', toolName: 'bash', matched: ['phone'], outcome: 'allowed-once', winner: 'phone' })
  ledger.record({ at: 't2', toolName: 'read', matched: [], outcome: 'unavailable' })
  ledger.record({ at: 't3', toolName: 'write', matched: ['phone', 'watch'], outcome: 'rejected', winner: 'watch' })
  const snapshot = ledger.snapshot()
  // The two that matter: `matched` is the denominator for "an answerer wanted
  // this", and `claimed`/`delegated` split the requests by who decided them.
  assert.equal(snapshot.matched, 2)
  assert.equal(snapshot.claimed, 2)
  assert.equal(snapshot.delegated, 1)
  assert.equal(snapshot.dispatched, 3)
})

test('a zero retention bound still keeps one record, so a report is never empty for THAT reason', () => {
  const ledger = createLedger(0)
  ledger.record({ at: 't', toolName: 'bash', matched: [], outcome: 'unavailable' })
  ledger.record({ at: 't2', toolName: 'bash', matched: [], outcome: 'unavailable' })
  assert.equal(ledger.snapshot().retained.length, 1)
  assert.equal(ledger.snapshot().dropped, 1)
})

test('the tally is addressed by declaration, and an unknown slot is created rather than thrown', () => {
  const ledger = createLedger(5)
  const index = ledger.declare('phone')
  assert.equal(index, 0)
  ledger.called(0)
  ledger.claimedBy(0, 'allowed-once')
  ledger.abstainedBy(0)
  ledger.erroredBy(0, new Error('boom'))
  // A call the plugin could only make by mistake: a report that throws answers
  // nothing, so the slot is created — and the gap is filled, because the report
  // lists answerers by index and a sparse array would skip the very slot it is
  // reporting on.
  ledger.called(7)
  const tallies = ledger.snapshot().answerers
  assert.equal(tallies.length, 8)
  assert.deepEqual({ ...tallies[0] }, { name: 'phone', calls: 1, claims: 1, abstains: 1, errors: 1, lastError: 'Error: boom' })
  assert.deepEqual({ ...tallies[7] }, { name: '#7', calls: 1, claims: 0, abstains: 0, errors: 0 })
})

test('a snapshot is a copy: later records do not rewrite a report already read', () => {
  const ledger = createLedger(5)
  ledger.record({ at: 't', toolName: 'bash', matched: [], outcome: 'unavailable' })
  const before = ledger.snapshot()
  ledger.record({ at: 't2', toolName: 'bash', matched: [], outcome: 'rejected' })
  assert.equal(before.dispatched, 1)
  assert.equal(before.retained.length, 1)
  assert.equal(ledger.snapshot().dispatched, 2)
})

test('an agent id is reported only when it is a usable string', () => {
  assert.equal(agentIdOf({ agent: { id: 'session-a' } }), 'session-a')
  assert.equal(agentIdOf({ agent: { id: '' } }), undefined)
  assert.equal(agentIdOf({ agent: {} }), undefined)
  assert.equal(agentIdOf({ agent: undefined }), undefined)
})

test('the report names its own posture when nothing has been seen', () => {
  const ledger = createLedger(5)
  const text = renderReport(ledger.snapshot(), { settings: defaultConfig, untagged: true, answerers: [] })
  assert.match(text, /admission: this listener's context carries no scope tag/)
  assert.match(text, /\(none registered — the bridge is a pass-through/)
  assert.match(text, /No request has reached this listener/)
})
