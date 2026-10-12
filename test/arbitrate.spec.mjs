/**
 * The arbitration, in isolation: it is the one piece whose failure is invisible
 * from the outside. A `Promise.race` here would look right in every arm where
 * exactly one surface answers, and would silently drop the answer of whichever
 * surface happened to be asked second.
 *
 * @module test/arbitrate.spec
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { arbitrate, isClaiming, CLAIMING, OUTCOMES } from '../lib/index.js'

const claims = value => isClaiming(value.outcome)

/** A participant that resolves after `ms`. */
function later(ms, value) {
  return new Promise(resolve => { setTimeout(() => { resolve(value) }, ms) })
}

test('the closed vocabulary is the harness\'s own four outcomes', () => {
  assert.deepEqual([...OUTCOMES], ['allowed-once', 'rejected', 'cancelled', 'unavailable'])
  assert.deepEqual([...CLAIMING], ['allowed-once', 'rejected', 'cancelled'])
  assert.equal(isClaiming('unavailable'), false)
  assert.equal(isClaiming(undefined), false)
  assert.equal(isClaiming('allow'), false)
})

test('nobody deciding is distinguishable from everybody abstaining', async () => {
  assert.equal(await arbitrate([], claims), undefined)
  assert.equal(await arbitrate([Promise.resolve(undefined), Promise.resolve(undefined)], claims), undefined)
  assert.equal(await arbitrate([Promise.resolve(undefined)], claims), undefined)
})

test('an abstention does not win a race it settled first', async () => {
  const decided = await arbitrate([
    later(1, undefined),
    later(5, { outcome: 'rejected' }),
  ], claims)
  assert.deepEqual(decided, { outcome: 'rejected' })
})

test('a rejection is an abstention, not a decision', async () => {
  const decided = await arbitrate([
    Promise.reject(new Error('boom')),
    later(1, { outcome: 'allowed-once' }),
  ], claims)
  assert.deepEqual(decided, { outcome: 'allowed-once' })
})

test('every participant abstaining rejects into the same answer as settling undefined', async () => {
  assert.equal(await arbitrate([Promise.reject(new Error('a')), Promise.resolve(undefined)], claims), undefined)
})

test('the first claim wins, and a slower claim does not replace it', async () => {
  const decided = await arbitrate([
    later(1, { outcome: 'rejected' }),
    later(5, { outcome: 'allowed-once' }),
  ], claims)
  assert.deepEqual(decided, { outcome: 'rejected' })
})

test('a loser that settles after the win keeps its handler', async () => {
  let rejectLate
  const late = new Promise((_resolve, reject) => { rejectLate = reject })
  const decided = await arbitrate([later(1, { outcome: 'cancelled' }), late], claims)
  assert.deepEqual(decided, { outcome: 'cancelled' })
  // The point of this arm is the settle after the answer: every participant is
  // handed a handler win or lose, so this rejection cannot surface as an
  // unhandled one — and `node --test` fails a run that produces one.
  rejectLate(new Error('late'))
  await later(5, undefined)
})
