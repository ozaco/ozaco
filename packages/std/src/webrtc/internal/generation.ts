import { createQueue } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'

import { RtcErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { RtcDef } from '../types/rtc'

import { initOf } from './channel'

const emptyGeneration = (pc: RtcDef.PeerLike): Helpers.Generation => ({
  pc,
  alive: true,
  negotiations: createQueue<Helpers.NegotiationRequest, void>(),
  outages: createQueue<string, void>(),
  candidatesOut: createQueue<RtcDef.CandidateLike | null, void>(),
  incoming: createQueue<RtcDef.ChannelLike, void>(),
  makingOffer: false,
  ignoreOffer: false,
  settingRemoteAnswer: false,
  kicked: false,
  pendingCandidates: [],
})

/** A `failed` state: hand the outage to the ICE-restart supervisor, or end the generation. */
const onFailed = (session: Helpers.Session, generation: Helpers.Generation) => {
  session.counters.failures += 1

  if (session.restart) {
    generation.outages.add('failed')
    return
  }

  session.endGeneration(
    generation,
    fail(RtcErrors.Connection, 'peer connection failed') as Result.Failure<unknown>,
    { state: 'failed', reason: 'failed' },
  )
}

/** An impl-initiated `closed` state: a generation death under `reconnect`, terminal otherwise. */
const onClosed = (session: Helpers.Session, generation: Helpers.Generation) => {
  if (!session.reconnect) {
    session.settle(true, { state: 'closed', reason: 'closed' })
    return
  }

  session.endGeneration(
    generation,
    fail(
      RtcErrors.Connection,
      'the implementation closed the connection',
    ) as Result.Failure<unknown>,
    { state: 'closed', reason: 'closed' },
  )
}

// on* assignment (not addEventListener): PeerLike is the handler-property shape shared by the
// browser RTCPeerConnection and the node-datachannel polyfill.

/** Hook one generation into the session: states, candidates, remote channels/tracks, and the
 * impl's own renegotiation requests all land in the session's queues. */
const wire = (session: Helpers.Session, generation: Helpers.Generation) => {
  const { pc } = generation
  const { counters, observe } = session
  const live = () => generation.alive && !session.ended

  pc.onconnectionstatechange = () => {
    if (!live()) {
      return
    }

    const current = pc.connectionState
    session.states.add(current)
    observe.record('state', current)

    if (current === 'connected' && counters.connectedMs === undefined) {
      counters.connectedMs = Date.now() - counters.startedAt
    }

    if (current === 'failed') {
      onFailed(session, generation)
    } else if (current === 'closed' && !session.closedByClient) {
      onClosed(session, generation)
    }
  }

  pc.onicecandidate = event => {
    if (live()) {
      generation.candidatesOut.add(event.candidate ?? null)
    }
  }

  pc.ondatachannel = event => {
    if (live()) {
      generation.incoming.add(event.channel)
    }
  }

  pc.onnegotiationneeded = () => {
    if (!live()) {
      return
    }

    if (generation.kicked) {
      generation.kicked = false // our own channel kick already queued this negotiation
      return
    }

    generation.negotiations.add({ kind: 'needed' })
  }

  pc.ontrack = event => {
    if (live()) {
      session.tracks.add({ track: event.track, streams: event.streams ?? [] })
      counters.tracksReceived += 1
      observe.record('track', `in:${event.track.kind}`)
    }
  }
}

/** Recreate every locally-opened channel on a fresh connection — same handles, new natives. */
const rebindChannels = (session: Helpers.Session, pc: RtcDef.PeerLike) => {
  for (const record of session.localRecords) {
    try {
      record.entry.rebind(pc.createDataChannel(record.label, initOf(record.options)))
    } catch {
      // an unconstructable channel surfaces through its own flows when the session settles
    }
  }
}

/** Re-add every live local track; returns how many made it onto the fresh connection. */
const readdTracks = (session: Helpers.Session, pc: RtcDef.PeerLike) => {
  let live = 0

  for (const record of session.trackRecords) {
    if (record.removed || !record.track) {
      continue
    }

    try {
      record.sender = pc.addTrack?.(record.track, ...record.streams)
      live += 1
    } catch {
      // an unaddable track surfaces through the negotiation path
    }
  }

  return live
}

/** The message of a thrown value, for failure texts. */
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * Dial ONE generation: construct, wire, adopt as current, recreate every local channel and
 * track on it, kick negotiation. Returns an error message when construction itself failed.
 */
export const dialGeneration = (
  session: Helpers.Session,
  impl: RtcDef.ImplLike,
): string | undefined => {
  const { options, counters, observe } = session

  let pc: RtcDef.PeerLike
  try {
    pc = new impl({
      ...options.configuration,
      ...(options.iceServers ? { iceServers: options.iceServers } : {}),
    })
  } catch (error) {
    counters.failures += 1
    observe.record('error', 'construct', { error: messageOf(error) })

    return messageOf(error)
  }

  const generation = emptyGeneration(pc)
  observe.generation += 1
  counters.generations += 1
  observe.record('dial')

  wire(session, generation)
  session.generation = generation

  rebindChannels(session, pc)

  // media always renegotiates, so its kick covers the channels too
  if (readdTracks(session, pc) > 0) {
    generation.kicked = true
    generation.negotiations.add({ kind: 'track' })
  } else if (session.localRecords.size > 0) {
    generation.kicked = true
    generation.negotiations.add({ kind: 'channel' })
  }

  session.dial.notify()

  return undefined
}
