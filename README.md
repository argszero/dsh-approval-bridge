# @argszero/dsh-approval-bridge

Lets a plugin **receive and answer approval requests**, and tells you when it does
not.

The harness dispatches an approval as a scope-filtered waterfall, and two
properties of that one dispatch decide whether a plugin's listener is ever
reached — neither of which logs anything when it is not:

- **the dispatch is filtered by scope.** A listener on a scope-tagged context is
  admitted only for that scope's own agent and its ancestors. Every other agent's
  request is filtered out silently.
- **registration order decides first refusal.** The application's own forwarder to
  the browser is registered on the profile context. A listener registered after
  it — the normal case for a plugin mounted later — is never called, because the
  forwarder already returned an outcome.

So a third-party surface (a phone, an IM bot, a watch, a voice channel) can never
be reached, and a plugin author who registers an `approval/request` listener and
watches it never fire cannot tell *"I am not admitted"* from *"nobody ever
asked"*.

One report, one mechanism, one seam:
[#9551](https://github.com/deepseek-ai/deepseek-harness/discussions/9551).

## The problem

`packages/interaction/user-approval/src/index.ts` dispatches:

```js
this.ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req,
  () => Promise.resolve<ApprovalOutcome>('unavailable'))
```

`scopeTarget(agent, key)` returns the dispatch context a listener must be
related to in order to be admitted, and the relationship is one-directional —
`@deepseek-ai/dsh-scope` says so in as many words: *"A tag BELOW the dispatch key
stays excluded — events flow up the chain, never down."* A listener registered on
a descendant or a sibling of the asking agent is skipped, and the skip produces no
log line.

The second half is not about the harness at all. A waterfall stops at the first
listener that returns a value, and the application registers its own forwarder at
`packages/api/remotes/src/index.ts`:

```ts
forwardWaterfall('approval/request', …)   // { event: 'approval/request', mode: 'waterfall' }
```

A plugin mounted later registers *after* that listener, so it is never entered —
not filtered, simply never reached, because the forwarder already answered.

## The seam

Both halves close with **one listener, on an untagged context, registered with
`{ prepend: true }`**:

```js
ctx.on('approval/request', async (req, next) => { … }, { prepend: true })
```

- untagged ⇒ `scopeOf(ctx) === undefined`, and the scope filter admits an untagged
  listener for **every** dispatch; and
- `prepend` ⇒ it is entered **before** the application's own forwarder.

Both were measured against the published line rather than read off the source. A
probe that registers exactly that listener observes a real approval request the
host chain leaves unanswered (`fired=1 outcome=unavailable`); the identical
listener registered without `prepend` is entered *after* the forwarder (order
`['bridge', 'forwarder']`); a listener on a sibling agent's scope is admitted for
its own scope only; and `isScopeCarrier(ctx)` is true even where `scopeOf(ctx)` is
`undefined` — which is why the untagged test is written against `scopeOf` and not
against the carrier.

This plugin registers that one listener and turns it into a registry. Your surface
plugin injects `ctx.approvalBridge` and registers an answerer:

```ts
export function apply(ctx: Context) {
  ctx.inject(['approvalBridge'], (scoped) => {
    scoped.effect(() => scoped.approvalBridge.register({
      name: 'phone',
      match: ask => ask.toolName === 'bash',
      answer: async ask => (await promptOnThePhone(ask)) ?? undefined,
    }))
  })
}
```

Registration order is the order answered in and the order the report lists. An
answerer returns a **claiming** outcome (`'allowed-once'`, `'rejected'`,
`'cancelled'`) to decide the request, or an abstention (`undefined` / `null` /
`'unavailable'`) to leave it to the others. The first claiming value wins:
abstentions do not end the exchange, and a throwing answerer is contained as an
abstention it did not choose — **no answerer's bug can fail an approval open**,
and the throw is reported rather than swallowed.

## Install

```sh
npm install @argszero/dsh-approval-bridge
```

Mount it in a dsh profile like any other plugin, or apply the bundle patch this
package ships:

```yaml
- insert:
    - id: approval-bridge
      name: '@argszero/dsh-approval-bridge'
      config:
        mode: bridge
```

The plugin declares `dsh.bundle.patch`, so `cordis.patch.yml` is what the harness
applies; the file carries the source anchors this README cites.

**Mount it at the profile (root) level.** Mounting it below an agent scope is
allowed — the listener still works, it just sees fewer requests — and the plugin
logs the consequence at mount time and reports the posture, because a narrowed
listener that stays silent is the exact failure this package exists to make
visible.

## Configuration

| option | default | meaning |
|---|---|---|
| `mode` | `'bridge'` | `bridge` arbitrates registered answerers against the host chain; `observe` decides nothing and only counts; `off` installs no listener |
| `hostChain` | `'race'` | `race` starts `next()` immediately and takes the first claimant; `defer` asks the answerers first and calls `next()` only when every one abstains |
| `report` | `true` | register the read-only `approval_bridge_report` tool |
| `maxReported` | `25` | how many request records the in-memory report retains |

A misspelled `mode` or `hostChain` is **reported and replaced**, never silently
honoured: falling back to the default is invisible from the outside, which is the
one failure shape this plugin exists to make visible elsewhere.

`observe` is how a deployment is measured before the bridge is trusted — it
decides nothing and writes nothing, but it counts every dispatch it is admitted
for. `off` installs no listener and still registers the report tool, whose job in
that posture is to say that the bridge is off.

`race` adds no latency of its own and is what a deployment with two surfaces
online at once means by "first answer wins". Its cost is honest and belongs to the
deployment: see the boundaries below. `defer` never draws the host card for a
request the bridge answers, at the price of the answerer's own latency on the
abstention path — bounded by the request's own signal, never by a clock this
plugin invented.

## The report

```sh
# the report is a tool; read it from the model's own call, or:
```

```
# approval-bridge report

mode: bridge (host chain: race)
admission: this listener's context carries no scope tag, so it is admitted for every agent's requests.

requests this listener saw: 3
  matching at least one answerer: 2
  claimed by an answerer: 1
  left to the host chain: 2
outcomes returned: allowed-once 1, rejected 0, cancelled 0, unavailable 2

## answerers
  #0 phone filtered — calls 2, claims 1, abstains 1, errors 0
  #1 watch — calls 3, claims 0, abstains 2, errors 1
      last error: Error: not an approval outcome: "yes" (expected one of allowed-once, rejected, cancelled, unavailable)

(calls counts the requests an answerer was asked to decide — its own `match` filter runs first, so a
 filtered answerer is never called for a tool it excluded)

## the 3 most recent requests
- 2026-10-13T00:00:00.000Z tool=bash call=call_1 agent=agent_7 matched=[phone] winner=phone -> allowed-once
- 2026-10-13T00:00:01.000Z tool=write matched=[watch] winner=(host chain) -> unavailable
- 2026-10-13T00:00:02.000Z tool=read matched=[none] winner=(host chain) -> unavailable
```

`requests this listener saw` is the point of the whole tool. It is the
**denominator** the harness does not produce: it separates *"this listener is not
admitted at all"* from *"no approval was ever requested"*. A bridge mounted where
its own scope admits it sees every request it is composed for; one mounted below
an unrelated scope sees none. When the count is zero and the deployment certainly
did ask for approvals, the report says so, and says why.

## Honest boundaries

- **It cannot make a *tagged* listener admitted.** Scope filtering belongs to the
  dispatcher. Mounting the bridge below an agent scope narrows what it sees; the
  report names that posture rather than hiding it.
- **It cannot withdraw a card the host chain already drew.** Under the default
  `race` posture `next()` is started immediately, so a deployment where two
  surfaces are online at once may see the bridge win while the other surface's
  prompt is still on screen. Withdrawing it is that surface's business, not a
  runtime-plane plugin's. `defer` is the posture that never draws the host card.
- **It cannot answer anything by itself.** Whether a surface may grant a
  permission is a deployment's policy. This plugin supplies the seam, the
  arbitration and the audit — not a decision.
- **It cannot override the session's `'never'` policy.** The approval service
  resolves that *before* dispatching (`effectivePolicy(session) === 'never'`
  returns `'rejected'` without entering the waterfall), so a `never` session never
  reaches this listener, in any mode.
- **A late answer is dropped, not queued.** Once a request has settled, a
  participant that answers afterwards is ignored — there is nothing left to
  decide. Under `race` that is the whole design; under `defer` the answerers are
  awaited before `next()` is called, so nothing is dropped there.

## Tests

```sh
npm test               # build + the suite (41 arms)
npm run test:inject    # mutation harness: does the suite actually notice?
npm run test:probe-lines   # pin every line the peer range admits, per line
```

The integration arms run against a **real** cordis context and the **real**
`ToolRuntime` from `@deepseek-ai/dsh-tools`, dispatching through
`ctx.tools.execute()` and through a real waterfall — so the pipeline under test is
the shipped one. Every arm runs twice, with the plugin and without it, which is
what turns "the mutation had no effect" into "this plugin is why".

## Compatibility

`peerDependencies` admit one explicit segment per published harness line — seven
of them, from `0.1.2-rc.1` to `0.2.1-alpha.2` — and `npm run test:probe-lines`
pins **the whole line** (not just the packages this plugin imports), installs,
builds and runs the suite per line. All seven pass:

```
0.1.2-rc.1  PASS      0.1.6-alpha.2   PASS      0.2.0-rc.2     PASS
0.1.3-alpha.2  PASS   0.1.7-rc.2      PASS      0.2.1-alpha.2  PASS
0.1.5-rc.3  PASS
```

A line that fails there is removed from the range and this section rather than
left claimed. Two harness packages the probe tree needs — `dsh-sandbox` and
`dsh-storage-domain` — are reached from `@deepseek-ai/dsh-tools` at runtime but
named by no published manifest, so the probe derives them from the installed
builds and pins them with the line; without that the suite cannot load at all and
every line would fail for a reason that has nothing to do with the line.

`@deepseek-ai/cordis` is a peer as well but is not pinned per line: its version
numbering does not follow the harness's, so it carries its own union of segments.

The one value import — `defineTool` from `@deepseek-ai/dsh-tools` — is declared as
a peer rather than a dependency on purpose: a `dependencies` entry is how a plugin
ends up in a `profile` deployment with its own copy of the registry's package, a
second evaluation whose symbols are equal to nothing the host holds.

## License

MIT.
