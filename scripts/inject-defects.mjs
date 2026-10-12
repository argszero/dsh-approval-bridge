/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is
 * SILENT — it proves nothing about the suite, and this harness reports it as a
 * failure of itself rather than hiding it.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm **emits** first: a
 * mutation that is never compiled is a mutation the suite cannot see, and one
 * that does not compile is reported as TYPEFAIL, because it never reached the
 * suite either.
 *
 * Every arm is a defect this package could plausibly have shipped — one
 * distinction it exists to make, removed with one edit. The arms that matter
 * most are the ones where the bridge would still *look* like it works:
 *
 * - the **prepend** — this is the upstream defect itself, reproduced inside the
 *   repair. Without it the listener is registered after the application's own
 *   forwarder, is never entered, and the plugin reports a quiet deployment.
 * - the **untagged context** — the other half of the same defect. A listener on
 *   a scope-tagged context is admitted for one agent family and silently skipped
 *   for every other.
 * - the **abstention vocabulary** — treating `'unavailable'` as a decision ends
 *   every exchange at the first surface that has no answer, which is exactly the
 *   `Promise.race` bug this package's arbitration exists to avoid.
 * - the **containment** — an answerer's throw must never fail an approval *open*,
 *   and must never be silent either.
 * - the **denominator** — a report that cannot tell "nothing was missed" from
 *   "nothing ran" is the reason the dispatch counter exists.
 * - the **host chain** — under `race` the host's own surface must be reached at
 *   the moment it would have been without this plugin.
 *
 * ```sh
 * node scripts/inject-defects.mjs                 # every arm
 * node scripts/inject-defects.mjs --filter=prepend # a subset
 * ```
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc')

/** Each arm names the one distinction it removes, and the file it lives in. */
const MUTATIONS = [
  {
    name: 'prepend: the listener is registered after the application\'s own forwarder',
    file: 'src/index.ts',
    edits: [['    }, { prepend: true })', '    })']],
  },
  {
    name: 'admission: an untagged context is read as a tagged one',
    file: 'src/index.ts',
    edits: [['  const untagged = scopeOf(ctx) === undefined', '  const untagged = scopeOf(ctx) !== undefined']],
  },
  {
    name: 'off: the early return is unreachable, so "off" mounts a listener',
    file: 'src/index.ts',
    // Cast to `string` on purpose: comparing a `BridgeMode` to a literal it does
    // not admit is a compile error, and an arm that cannot compile measures the
    // arm, not the suite.
    edits: [['  if (settings.mode === \'off\') return', '  if ((settings.mode as string) === \'never\') return']],
  },
  {
    name: 'observe: the observing posture decides',
    file: 'src/index.ts',
    edits: [['        decision = settings.mode === \'observe\'', '        decision = settings.mode === \'bridge\'']],
  },
  {
    name: 'report: the tool is registered exactly when it was switched off',
    file: 'src/index.ts',
    edits: [['  if (settings.report) {', '  if (!settings.report) {']],
  },
  {
    name: 'service: ctx.approvalBridge is never provided, so no surface can register',
    file: 'src/index.ts',
    edits: [['  ctx.provide(\'approvalBridge\', bridge)', '  void bridge']],
  },
  {
    name: 'vocabulary: \'unavailable\' is taken as a decision instead of an abstention',
    file: 'src/index.ts',
    edits: [['    if (value === undefined || value === null || value === \'unavailable\') {', '    if (value === undefined || value === null) {']],
  },
  {
    name: 'containment: a throwing answerer grants the request',
    file: 'src/index.ts',
    edits: [['      ledger.erroredBy(slot.index, error)\n      return undefined', '      ledger.erroredBy(slot.index, error)\n      return { outcome: \'allowed-once\', winner: slot.name }']],
  },
  {
    name: 'vocabulary: a non-vocabulary return is a chosen abstention, and is not reported',
    file: 'src/index.ts',
    edits: [['    ledger.erroredBy(slot.index, new Error(`not an approval outcome: ${describe(value)} (expected one of allowed-once, rejected, cancelled, unavailable)`))',
      '    ledger.abstainedBy(slot.index)']],
  },
  {
    name: 'unregister: a retired surface is still asked',
    file: 'src/index.ts',
    edits: [['        if (slot.retired) continue', '        if (slot.retired && (false as boolean)) continue']],
  },
  {
    name: 'match: the filter is bypassed, so every answerer sees every request',
    file: 'src/index.ts',
    // `|| (true as boolean)` rather than a bare `true`: the branch has to stay
    // reachable for the type of `slot.match` below it, or the arm fails to
    // compile and measures itself instead of the suite.
    edits: [['      if (slot.match === undefined) {', '      if (slot.match === undefined || (true as boolean)) {']],
  },
  {
    name: 'match: a throwing filter silences the surface in silence',
    file: 'src/index.ts',
    edits: [['          ledger.erroredBy(slot.index, error)', '          ledger.abstainedBy(slot.index)']],
  },
  {
    name: 'posture: defer and race are exchanged',
    file: 'src/index.ts',
    edits: [['    if (settings.hostChain === \'defer\') {', '    if (settings.hostChain === \'race\') {']],
  },
  {
    name: 'race: the registered answerers are never arbitrated against the host chain',
    file: 'src/index.ts',
    edits: [['    const decided = await arbitrate([host, ...matched.map(slot => askOne(slot, ask))], claims)',
      '    const decided = await arbitrate([host], claims)']],
  },
  {
    name: 'ledger: the "matched at least one answerer" counter counts the unmatched',
    file: 'src/ledger.ts',
    edits: [['      if (entry.matched.length > 0) matched += 1', '      if (entry.matched.length === 0) matched += 1']],
  },
  {
    name: 'ledger: claimed and delegated are exchanged',
    file: 'src/ledger.ts',
    edits: [['      if (entry.winner === undefined) delegated += 1\n      else claimed += 1',
      '      if (entry.winner === undefined) claimed += 1\n      else delegated += 1']],
  },
  {
    name: 'ledger: the retention bound drops the newest records, not the oldest',
    file: 'src/ledger.ts',
    edits: [['        retained.shift()', '        retained.pop()']],
  },
  {
    name: 'ledger: every answerer is declared into slot zero',
    file: 'src/ledger.ts',
    edits: [['      return tallies.length - 1', '      return 0']],
  },
  {
    name: 'report: the denominator is the claim count',
    file: 'src/report.ts',
    edits: [['  lines.push(`requests this listener saw: ${snapshot.dispatched}`)', '  lines.push(`requests this listener saw: ${snapshot.claimed}`)']],
  },
  {
    name: 'report: the admission line is printed for the opposite posture',
    file: 'src/report.ts',
    edits: [['  lines.push(facts.untagged', '  lines.push(!facts.untagged']],
  },
  {
    name: 'report: the "nothing reached me" explanation is printed in the one mode it cannot apply to',
    file: 'src/report.ts',
    edits: [['  if (snapshot.dispatched === 0 && settings.mode !== \'off\') {', '  if (snapshot.dispatched === 0 && settings.mode === \'off\') {']],
  },
  {
    name: 'config: an unknown mode is silently replaced',
    file: 'src/config.ts',
    edits: [['  if (!MODES.includes(mode)) rejected.push(`mode (${String(mode)})`)', '  if ((false as boolean)) rejected.push(`mode (${String(mode)})`)']],
  },
  {
    name: 'config: the default posture is "off"',
    file: 'src/config.ts',
    edits: [['  mode: \'bridge\',', '  mode: \'off\',']],
  },
  {
    name: 'arbitrate: an abstention settles the exchange',
    file: 'src/arbitrate.ts',
    edits: [['      if (remaining === 0) settle(undefined)', '      if (remaining >= 0) settle(undefined)']],
  },
]

const argv = process.argv.slice(2)
const filter = argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length)

/**
 * Run one command, capturing whether it succeeded.
 *
 * The timeout is not decoration: an arm can leave the suite waiting on
 * something, and a mutant that never terminates is a mutant the suite cannot
 * report on. It is killed here and counted as caught, which is what it is — the
 * suite never reaches its assertions because the code under test never returns.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Emit the compiled artifact the suite actually imports. */
function build() {
  return run(process.execPath, [TSC])
}

/** Run every spec in the suite. */
function test() {
  return run(process.execPath, ['--test', 'test/*.spec.mjs'])
}

const results = []
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  // A malformed arm is worse than a missing one: `for (const [from, to] of
  // 'ab')` destructures a *string* into its characters, so the edit becomes a
  // search for two single characters and a rewrite that changes nothing — and
  // the arm then reports SILENT, blaming the suite for a harness bug.
  const malformed = mutation.edits.some(edit =>
    !Array.isArray(edit) || edit.length !== 2 || edit.some(part => typeof part !== 'string'))
  if (malformed) {
    results.push({ name: mutation.name, outcome: 'MALFORMED', detail: 'an edit is not a [from, to] pair of strings' })
    continue
  }
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = build()
    if (!built.ok) {
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: 'the mutation does not compile, so the suite never ran' })
      continue
    }
    const tested = test()
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The last arm left its mutation COMPILED there — the source is
// restored in the `finally` above, but the build output is not, and a checkout
// that runs this script and then publishes would ship the last mutant. Rebuilt
// once here so the tree is consistent whether a human runs this or CI does.
const restored = build()
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declared = new Set(MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name))
const equivalents = results.filter(result => result.outcome === 'SILENT' && declared.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declared.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declared.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}
process.stdout.write(`\n${caught}/${results.length} caught`)
process.stdout.write(silent.length === 0
  ? ` — no arm is silent (${equivalents.length} declared equivalent — see the arms)\n`
  : `, ${silent.length} SILENT\n`)
if (other.length > 0) {
  process.stdout.write(`${other.length} arm(s) could not be evaluated: ${other.map(result => `${result.outcome} ${result.name}`).join(', ')}\n`)
}
process.exitCode = silent.length === 0 && other.length === 0 ? 0 : 1
