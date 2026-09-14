import type { Operation } from 'std:effect'
import { attempt, fork, resource } from 'std:effect'
import { fail } from 'std:result'

import { RtcErrors } from '../errors'
import type { RtcDef } from '../types/rtc'

import { dialGeneration } from './generation'
import { createHandle } from './handle'
import { superviseNegotiation } from './negotiation'
import { pumpCandidates, pumpIncoming, pumpSignal, sampleStats } from './pumps'
import { createSession } from './session'
import { superviseIce, superviseReconnect } from './supervise'

/**
 * Open a peer as a RESOURCE bound to the caller's scope: the body dials the first generation,
 * forks the signal pump + candidate pump + negotiation supervisor + incoming-channel pump (+ the
 * ICE-restart and session-reconnect supervisors when budgeted), provides the peer handle, and —
 * when the scope closes — signals `rtc:bye`, closes the connection, and settles every flow in
 * its teardown. Negotiation follows the perfect-negotiation pattern: `polite` decides who rolls
 * back on offer glare. With `reconnect`, a dead connection (failure, ICE exhaustion, impl close)
 * is REDIALED as a whole new generation over the same signal: locally-opened channels are
 * recreated and rebound (their handles and flows continue), the remote peer's channels close
 * cleanly and fresh ones re-emit on `channels`. A remote `rtc:bye` (deliberate hang-up), a local
 * `close()`, and a dead signal are never redialed.
 */
export const createPeer = (
  impl: RtcDef.ImplLike,
  signal: RtcDef.SignalLike,
  options: RtcDef.Options,
): Operation<RtcDef.Peer> =>
  resource(function* (provide) {
    const session = createSession(signal, options)

    // initial dial — a construction failure surfaces directly to the connect() caller
    const dialError = dialGeneration(session, impl)
    if (dialError !== undefined) {
      return yield* fail(RtcErrors.Connect, `peer construction failed: ${dialError}`)
    }

    yield* fork(() => pumpSignal(session))
    yield* fork(() => pumpCandidates(session))
    yield* fork(() => superviseNegotiation(session))
    yield* fork(() => pumpIncoming(session))

    if (session.restart) {
      const budget = session.restart
      yield* fork(() => superviseIce(session, budget))
    }

    if (session.reconnect) {
      const budget = session.reconnect
      yield* fork(() => superviseReconnect(session, impl, budget))
    }

    const sampleMs = options.observe?.sampleMs ?? 0
    if (sampleMs > 0) {
      yield* fork(() => sampleStats(session, sampleMs))
    }

    try {
      yield* provide(createHandle(session))
    } finally {
      // scope teardown: the peer is a resource — say goodbye, close the connection, settle.
      session.closedByClient = true

      if (!session.ended) {
        yield* attempt(() => session.sendFrame({ t: 'rtc:bye' }))
        session.settle(true, { state: session.stateOf(), reason: 'scope closed' })
      }
    }
  })
