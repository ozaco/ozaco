import type { Flow, Operation, Queue } from 'std:effect'
import { attempt, lift, operation } from 'std:effect'
import { fail } from 'std:result'

import { RtcCauses, RtcErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { RtcDef } from '../types/rtc'

import { openChannel, openTrack } from './resources'
import { readStats } from './stats'

/** Expose a session queue as a single-consumer Flow. */
const flowOf = <T, TClose>(queue: Queue<T, TClose>): Flow<T, TClose> =>
  ({
    *[Symbol.iterator]() {
      return queue
    },
  }) as Flow<T, TClose>

/**
 * The consumer-facing peer over a session: the generation-independent getters, the
 * `channels` / `tracks` / `states` / `events` flows, the caller-scoped `channel` / `addTrack`
 * resources, and `close` — the client-initiated permanent end (also what the resource teardown
 * calls).
 */
export const createHandle = (session: Helpers.Session): RtcDef.Peer => {
  const { observe, counters } = session

  return {
    id: observe.id,
    events: observe.events,
    channels: flowOf(session.channels),
    tracks: flowOf(session.tracks),
    states: flowOf(session.states),
    closed: session.closed.future,

    get native() {
      return session.generation?.pc as RtcDef.PeerLike
    },
    get connectionState() {
      return session.stateOf()
    },
    get signalingState() {
      return session.generation?.pc.signalingState ?? 'closed'
    },
    get restarts() {
      return counters.restarts
    },
    get reconnects() {
      return counters.reconnects
    },
    get metrics() {
      return observe.metrics(session.stateOf())
    },
    get timeline() {
      return observe.timeline()
    },

    channel: (label, channelOptions) => openChannel(session, label, channelOptions),
    addTrack: (track, ...streams) => openTrack(session, track, streams),

    stats: operation(function* () {
      const generation = session.generation
      if (!generation?.alive) {
        return yield* fail(RtcErrors.Stats, 'the peer has no live connection to read stats from')
      }

      return yield* readStats(generation.pc)
    }, RtcCauses.Stats),

    restartIce: lift(() => {
      const generation = session.generation

      if (generation?.alive && !session.ended) {
        generation.negotiations.add({ kind: 'restart' })
      }
    }) as () => Operation<void>,

    close: operation(function* () {
      session.closedByClient = true

      if (!session.ended) {
        yield* attempt(() => session.sendFrame({ t: 'rtc:bye' }))
        session.settle(true, { state: session.stateOf(), reason: 'client' })
      }

      yield* session.closed.future
    }, RtcCauses.Close),
  }
}
