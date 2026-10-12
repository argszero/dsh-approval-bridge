/**
 * The plugin's configuration.
 *
 * The defaults are the posture that changes nothing for anyone who does not ask
 * for it: `bridge` runs the arbitration, but with no answerer registered the
 * listener is a pass-through, and `race` starts the host chain immediately, so a
 * request reaches the host's own surface at exactly the moment it would have
 * without this plugin.
 *
 * @module @argszero/dsh-approval-bridge/config
 */

/**
 * How the plugin treats the requests it sees.
 *
 * - `bridge` — arbitrate registered answerers against the host chain.
 * - `observe` — take no decision at all: count the dispatches this listener is
 *   admitted for and the answerers each request matches, then delegate. This is
 *   the posture that answers "is my listener even reached?", which is the
 *   question a plugin author cannot get answered anywhere else, because a
 *   scope-filtered listener is skipped with no log line.
 * - `off` — install no listener. The report tool still answers, and says so.
 */
export type BridgeMode = 'bridge' | 'observe' | 'off'

/**
 * When the host's own chain is started relative to the registered answerers.
 *
 * - `race` — start `next()` immediately and keep whichever participant produces
 *   a claiming outcome first. Adds no latency of its own, and is what a
 *   multi-surface deployment (desktop + phone online together) means by
 *   "first answer wins". The cost is honest and belongs to the deployment: if
 *   the bridge wins, a card the host's own surface had already drawn stays on
 *   screen, because withdrawing it is that surface's business, not a
 *   runtime-plane plugin's.
 * - `defer` — ask the registered answerers first and call `next()` only when
 *   every one of them abstains. No host card is ever drawn for a request the
 *   bridge answers, at the price of the answerer's own latency on the
 *   abstention path (still bounded by the request's signal, never by a clock
 *   this plugin invented).
 */
export type HostChainPolicy = 'race' | 'defer'

/** The plugin's user-facing configuration. Every field is optional. */
export interface Config {
  /** Response posture. Defaults to `bridge`. */
  mode?: BridgeMode
  /** How the host chain is started. Defaults to `race`. */
  hostChain?: HostChainPolicy
  /** Register the read-only report tool. Defaults to `true`. */
  report?: boolean
  /** How many request records the in-memory report retains. Defaults to 25. */
  maxReported?: number
}

/** The configuration with every default resolved. */
export interface Settings {
  readonly mode: BridgeMode
  readonly hostChain: HostChainPolicy
  readonly report: boolean
  readonly maxReported: number
}

/**
 * The default configuration.
 *
 * Deliberately **not** exported as the plugin's `Config`: a class plugin's
 * `static Config` is validated through `Config['~standard'].validate`, and a
 * plain defaults object there makes the mount throw
 * `Cannot read properties of undefined (reading 'validate')` before the
 * constructor runs. This plugin declares no `Config` at all, so the raw config
 * reaches the constructor and the defaults are applied here.
 */
export const defaultConfig: Settings = {
  mode: 'bridge',
  hostChain: 'race',
  report: true,
  maxReported: 25,
}

const MODES: readonly BridgeMode[] = ['bridge', 'observe', 'off']
const POLICIES: readonly HostChainPolicy[] = ['race', 'defer']

/** A positive integer, or the fallback. */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * Resolve a user configuration into settings.
 *
 * A misspelled `mode` or `hostChain` is **reported and replaced**, never
 * silently honoured: falling back to the default is invisible from the outside
 * (the plugin still works, just not the way the deployment asked), which is the
 * one failure shape this plugin exists to make visible elsewhere.
 * @param config - the raw configuration.
 * @returns the settings and the field names that had to be replaced.
 */
export function normalizeConfig(config: Config = {}): { settings: Settings; rejected: readonly string[] } {
  const rejected: string[] = []
  const mode = config.mode ?? defaultConfig.mode
  if (!MODES.includes(mode)) rejected.push(`mode (${String(mode)})`)
  const hostChain = config.hostChain ?? defaultConfig.hostChain
  if (!POLICIES.includes(hostChain)) rejected.push(`hostChain (${String(hostChain)})`)
  return {
    settings: {
      mode: MODES.includes(mode) ? mode : defaultConfig.mode,
      hostChain: POLICIES.includes(hostChain) ? hostChain : defaultConfig.hostChain,
      report: config.report ?? defaultConfig.report,
      maxReported: positive(config.maxReported, defaultConfig.maxReported),
    },
    rejected,
  }
}
