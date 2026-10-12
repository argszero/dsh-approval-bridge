/**
 * The arbitration: the first participant to produce a **claiming** value wins.
 *
 * This is not `Promise.race`. A race settles on the first promise to settle, so a
 * participant that answers "I have no answer" would win the race with an
 * abstention and end the exchange before the surface that does have an answer was
 * ever asked. The composition here settles on the first participant to produce a
 * value the caller calls a *decision*, ignores abstentions, and answers "nobody
 * decided" only once every participant has settled.
 *
 * The winner itself is the caller's business: the participants settle with
 * whatever they like, and `claims` is the caller's closed-vocabulary predicate
 * over that. That is what lets the bridge report *which* surface answered a
 * request rather than only that one did.
 *
 * @module @argszero/dsh-approval-bridge/arbitrate
 */

/**
 * Settle with the first value among `participants` that `claims` accepts.
 *
 * A participant resolves to `undefined` to abstain. A participant that rejects
 * also abstains — the caller owns containing an answerer's throw, and the
 * rejection handler here is the second line of defence for one that throws
 * anyway. Both are counted as settlements, so "everybody abstained" cannot be
 * missed because a participant failed.
 *
 * Every participant gets a settlement handler attached, win or lose, so a
 * participant this function stops waiting for can never surface as an unhandled
 * rejection.
 * @param participants - one promise per participant, each settling at most once.
 * @param claims - whether a settled value decides the request.
 * @returns the winning value, or `undefined` when every participant abstained.
 */
export function arbitrate<T>(
  participants: readonly Promise<T | undefined>[],
  claims: (value: T) => boolean,
): Promise<T | undefined> {
  if (participants.length === 0) return Promise.resolve(undefined)
  return new Promise<T | undefined>((resolve) => {
    let remaining = participants.length
    let settled = false
    const settle = (value: T | undefined): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const miss = (): void => {
      remaining -= 1
      if (remaining === 0) settle(undefined)
    }
    for (const participant of participants) {
      void participant.then(
        (value) => {
          if (value !== undefined && claims(value)) settle(value)
          else miss()
        },
        miss,
      )
    }
  })
}
