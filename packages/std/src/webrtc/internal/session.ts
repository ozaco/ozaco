import { createQueue, withResolvers } from 'std:effect'
import type { Result } from 'std:result'

import type { Helpers } from '../types/helpers'
import type { RtcDef } from '../types/rtc'

import { BUDGET_DEFAULTS } from './const'
import { candidateTypeOf, createObserver } from './observe'

const budgetOf = (
  options?: RtcDef.IceRestartOptions | RtcDef.ReconnectOptions,
): Helpers.Budget | undefined =>
  options
    ? {
        retries: options.retries ?? BUDGET_DEFAULTS.retries,
        delayMs: options.delayMs ?? BUDGET_DEFAULTS.delayMs,
        backoff: options.backoff ?? BUDGET_DEFAULTS.backoff,
        maxDelayMs: options.maxDelayMs ?? BUDGET_DEFAULTS.maxDelayMs,
      }
    : undefined

const unwire = (pc: RtcDef.PeerLike) => {
  pc.onconnectionstatechange = null
  pc.onicecandidate = null
  pc.ondatachannel = null
  pc.onnegotiationneeded = null
  pc.ontrack = null
}

/**
 * Create the state ONE peer session lives in. Nothing here touches the implementation: the
 * generation dialer adopts connections into `generation`, the pumps and supervisors read the
 * queues, the handle reads the flags — and `settle` / `endGeneration` are the shared end paths.
 */
export const createSession = (
  signal: RtcDef.SignalLike,
  options: RtcDef.Options,
): Helpers.Session => {
  const observe = createObserver(options.observe)

  /** candidate types already recorded per generation+direction (all of them are COUNTED — the
   * timeline only wants to know that a `srflx`/`relay` route appeared, not each candidate). */
  const seenCandidates = new Set<string>()

  // resolved every time a new generation dials (or the session ends) — `channel()` calls and
  // the per-generation pumps park here through a redial gap
  let dialGate = withResolvers<void>('rtc:dial')

  const session: Helpers.Session = {
    signal,
    options,
    polite: options.polite ?? false,
    restart: budgetOf(options.iceRestart),
    reconnect: budgetOf(options.reconnect),

    observe,
    counters: observe.counters,

    channels: createQueue<RtcDef.Channel, RtcDef.FlowClose>(),
    states: createQueue<string, RtcDef.FlowClose>(),
    tracks: createQueue<RtcDef.IncomingTrack, RtcDef.FlowClose>(),
    outages: createQueue<Result.Failure<unknown>, void>(),
    closed: withResolvers<RtcDef.CloseInfo>('rtc:closed'),

    localRecords: new Set<Helpers.LocalRecord>(),
    remoteEntries: new Set<Helpers.ChannelEntry>(),
    trackRecords: new Set<Helpers.TrackRecord>(),

    ended: false,
    closedByClient: false,
    signalEnded: false,
    generation: undefined,

    stateOf: () => session.generation?.pc.connectionState ?? 'closed',

    retainLocal: () =>
      Boolean(session.reconnect) &&
      !session.ended &&
      !session.closedByClient &&
      !session.signalEnded,

    dialed: () => dialGate.operation,

    notifyDial() {
      const gate = dialGate
      dialGate = withResolvers<void>('rtc:dial')
      gate.resolve()
    },

    sendFrame: frame => signal.send(frame),

    noteCandidate(direction, candidate) {
      const detail = `${direction}:${candidateTypeOf(candidate)}`
      const key = `${observe.generation}:${detail}`

      if (!seenCandidates.has(key)) {
        seenCandidates.add(key)
        observe.record('candidate', detail)
      }
    },

    teardownGeneration(generation) {
      if (!generation.alive) {
        return
      }

      generation.alive = false
      unwire(generation.pc)
      generation.negotiations.close()
      generation.outages.close()
      generation.candidatesOut.close()
      generation.incoming.close()
      generation.pc.close()
    },

    settle(close, info) {
      if (session.ended) {
        return
      }

      session.ended = true
      observe.record('close', info.reason, close === true ? {} : { error: String(close.error) })

      if (session.generation) {
        session.teardownGeneration(session.generation)
      }

      for (const record of session.localRecords) {
        record.entry.end(close)
      }
      session.localRecords.clear()

      for (const entry of session.remoteEntries) {
        entry.end(close)
      }
      session.remoteEntries.clear()
      session.trackRecords.clear()

      session.channels.close(close)
      session.states.close(close)
      session.tracks.close(close)
      session.outages.close()
      session.closed.resolve(info)
      observe.close(close)
      session.notifyDial()
    },

    // local channels suspend for the rebind, remote handles close cleanly — fresh ones re-emit
    // after the redial; without a redial the whole session settles
    endGeneration(generation, failure, info) {
      if (!generation.alive) {
        return
      }

      session.teardownGeneration(generation)

      if (session.ended || session.closedByClient) {
        return
      }

      if (!session.reconnect || session.signalEnded) {
        session.settle(failure, info)
        return
      }

      for (const record of session.localRecords) {
        record.entry.suspend()
      }

      for (const record of session.trackRecords) {
        record.sender = undefined // the dead generation's sender — re-added on the redial
      }

      for (const entry of session.remoteEntries) {
        entry.end(true)
      }
      session.remoteEntries.clear()

      session.outages.add(failure)
    },

    *awaitGeneration() {
      while (!session.ended) {
        const generation = session.generation
        if (generation?.alive) {
          return generation
        }

        yield* dialGate.operation
      }

      return undefined
    },

    *eachGeneration(body) {
      let previous: Helpers.Generation | undefined

      while (!session.ended) {
        const generation = session.generation

        if (!generation?.alive || generation === previous) {
          yield* dialGate.operation
          continue
        }

        previous = generation
        yield* body(generation)
      }
    },
  }

  return session
}
