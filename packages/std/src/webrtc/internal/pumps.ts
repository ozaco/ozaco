import { attempt, guard, sleep } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isSuccess } from 'std:result'

import { RtcCauses, RtcErrors } from '../errors'
import type { Helpers } from '../types/helpers'

import { wrapChannel } from './channel'
import { handleCandidate, handleDescription } from './negotiation'
import { candidateOf, frameOf } from './signal'
import { flatten, readStats } from './stats'

/**
 * Signal pump (forked once, session-lifetime): consumes the signaling flow and dispatches frames
 * to the CURRENT generation (parking through a redial gap so an early frame from the remote's
 * own redial is handled, not dropped). Non-`rtc:*` frames are ignored, so keepalive pings on a
 * shared socket are safe.
 */
export const pumpSignal = guard(function* (session: Helpers.Session) {
  const subscription = yield* session.signal.messages

  while (true) {
    const item = yield* subscription.next()

    if (item.done) {
      session.signalEnded = true

      // an established connection keeps running P2P (though it can no longer renegotiate or
      // redial — a later outage settles the session); an unestablished one can never come up
      if (session.stateOf() !== 'connected' && !session.closedByClient) {
        session.settle(
          fail(RtcErrors.Signal, 'signal closed during negotiation') as Result.Failure<unknown>,
          { state: session.stateOf(), reason: 'signal' },
        )
      }

      return
    }

    const frame = frameOf(item.value)
    if (!frame) {
      continue
    }

    if (frame.t === 'rtc:bye') {
      session.settle(true, { state: session.stateOf(), reason: 'bye' }) // deliberate hang-up
      return
    }

    const generation = yield* session.awaitGeneration()
    if (!generation) {
      return
    }

    if (frame.t === 'rtc:candidate') {
      yield* handleCandidate(session, generation, frame.candidate)
      continue
    }

    yield* handleDescription(session, generation, frame.description)

    if (session.ended) {
      return
    }
  }
}, RtcCauses.SignalPump)

/** Candidate pump (forked): best-effort — a dead signal surfaces through the negotiation path. */
export const pumpCandidates = guard(function* (session: Helpers.Session) {
  yield* session.eachGeneration(function* (generation) {
    while (true) {
      const item = yield* generation.candidatesOut.next()
      if (item.done) {
        return
      }

      yield* attempt(() =>
        session.sendFrame({ t: 'rtc:candidate', candidate: candidateOf(item.value) }),
      )

      session.counters.candidatesSent += 1
      session.noteCandidate('out', item.value)
    }
  })
}, RtcCauses.CandidatePump)

/**
 * Incoming-channel pump (forked): wrap each remote native, wait for it to OPEN, then emit it on
 * the `channels` flow — consumers never see a half-open channel. Remote handles die with their
 * generation; after a redial the remote side re-announces and fresh handles emit here.
 */
export const pumpIncoming = guard(function* (session: Helpers.Session) {
  const { options, observe, counters, remoteEntries } = session

  yield* session.eachGeneration(function* (generation) {
    while (true) {
      const item = yield* generation.incoming.next()
      if (item.done) {
        return
      }

      const entry = wrapChannel(item.value, options.channel ?? {}, {
        ...(options.codec === undefined ? {} : { codec: options.codec }),
        observe,
      })
      remoteEntries.add(entry)

      const opened = yield* attempt(() => entry.opened)
      if (!isSuccess(opened) || session.ended || !remoteEntries.has(entry)) {
        remoteEntries.delete(entry)
        entry.end(true)
        continue
      }

      session.channels.add(entry.handle)
      counters.channelsAccepted += 1
      observe.record('channel', `in:${entry.handle.label}`)
    }
  })
}, RtcCauses.IncomingChannels)

/**
 * Stats sampler (forked, only when `observe.sampleMs` is set): one `stats` timeline entry per
 * tick, carrying the flattened snapshot — the metrics feed a reporter can pump anywhere.
 */
export const sampleStats = guard(function* (session: Helpers.Session, everyMs: number) {
  while (!session.ended) {
    yield* sleep(everyMs)

    const generation = session.generation
    if (session.ended || !generation?.alive) {
      continue
    }

    const snapshot = yield* attempt(() => readStats(generation.pc))
    if (isSuccess(snapshot)) {
      session.observe.record('stats', undefined, { data: flatten(snapshot.value) })
    }
  }
}, RtcCauses.StatsSampler)
