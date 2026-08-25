import type { Flow, Future, Operation } from 'std:effect'
import {
  attempt,
  createQueue,
  fork,
  lift,
  operation,
  race,
  resource,
  sleep,
  until,
  withResolvers,
} from 'std:effect'
import type { Result } from 'std:result'
import { fail, isSuccess } from 'std:result'

import type { Helpers } from '../types/helpers'
import type { RtcDef } from '../types/rtc'

import { wrapChannel } from './channel'
import { candidateTypeOf, createObserver } from './observe'
import { candidateOf, descriptionOf, frameOf, hasDescription } from './signal'
import { flatten, readStats } from './stats'

const budgetOf = (options?: RtcDef.IceRestartOptions): Helpers.Budget | undefined =>
  options
    ? {
        retries: options.retries ?? 5,
        delayMs: options.delayMs ?? 250,
        backoff: options.backoff ?? 1,
        maxDelayMs: options.maxDelayMs ?? 30_000,
      }
    : undefined

const delayOf = (budget: Helpers.Budget, attemptNo: number) =>
  Math.min(budget.delayMs * budget.backoff ** attemptNo, budget.maxDelayMs)

/** Forward only the wire-init subset of the merged channel options to `createDataChannel`. */
const initOf = (channel: RtcDef.ChannelOptions): RtcDef.ChannelInit => ({
  ...(channel.ordered === undefined ? {} : { ordered: channel.ordered }),
  ...(channel.maxRetransmits === undefined ? {} : { maxRetransmits: channel.maxRetransmits }),
  ...(channel.maxPacketLifeTime === undefined
    ? {}
    : { maxPacketLifeTime: channel.maxPacketLifeTime }),
  ...(channel.protocol === undefined ? {} : { protocol: channel.protocol }),
})

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
  Ctor: RtcDef.PeerCtor,
  signal: RtcDef.SignalLike,
  options: RtcDef.Options,
): Operation<RtcDef.Peer> =>
  resource(function* (provide) {
    const polite = options.polite ?? false
    const restart = budgetOf(options.iceRestart)
    const reconnect = budgetOf(options.reconnect)

    // counters + timeline + live event flow; every pump below reports into it
    const observe = createObserver(options.observe)
    const counters = observe.counters
    /** candidate types already recorded per generation+direction (all of them are COUNTED — the
     * timeline only wants to know that a `srflx`/`relay` route appeared, not each candidate). */
    const seenCandidates = new Set<string>()

    // remote-opened channels, already OPEN when emitted (see the incoming pump)
    const channelsQueue = createQueue<RtcDef.Channel, RtcDef.FlowClose>()
    // connectionState transitions for the `states` flow (continuous across generations)
    const statesQueue = createQueue<string, RtcDef.FlowClose>()
    // generation deaths, one at a time, for the session-reconnect supervisor
    const sessionOutages = createQueue<Result.Failure<unknown>, void>()
    const closedResolvers = withResolvers<RtcDef.CloseInfo>('rtc:closed')
    // tracks the remote announces, for the `tracks` flow (continuous across generations)
    const tracksQueue = createQueue<RtcDef.IncomingTrack, RtcDef.FlowClose>()
    // locally-opened channels (rebound on redial) and live remote entries (per generation)
    const localRecords = new Set<Helpers.LocalRecord>()
    const remoteEntries = new Set<Helpers.ChannelEntry>()
    // locally-added media tracks (re-added on redial until removed)
    const trackRecords = new Set<Helpers.TrackRecord>()

    const session = {
      /** Permanently ended: every queue is closed and `closed` is resolved. */
      ended: false,
      /** `close()` was called (or the scope tore down) — never redial past this point. */
      closedByClient: false,
      /** The signal flow ended — negotiation (and therefore any redial) is impossible. */
      signalEnded: false,
      generation: undefined as Helpers.Generation | undefined,
    }

    // resolved every time a new generation dials (or the session ends) — `channel()` calls and
    // the per-generation pumps park here through a redial gap
    let dialGate = withResolvers<void>('rtc:dial')
    const notifyDial = () => {
      const gate = dialGate
      dialGate = withResolvers<void>('rtc:dial')
      gate.resolve()
    }

    const stateOf = () => session.generation?.pc.connectionState ?? 'closed'

    /** May the channel layer hold a dying native for a rebind instead of settling? */
    const retainLocal = () =>
      Boolean(reconnect) && !session.ended && !session.closedByClient && !session.signalEnded

    const unwire = (pc: RtcDef.PeerLike) => {
      pc.onconnectionstatechange = null
      pc.onicecandidate = null
      pc.ondatachannel = null
      pc.onnegotiationneeded = null
      pc.ontrack = null
    }

    /** Stop ONE generation: unhook, close its queues (pumps drain out), close the native. */
    const teardownGeneration = (generation: Helpers.Generation) => {
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
    }

    /** Permanent end — runs at most once: tears the current generation, force-ends every
     * channel, closes every session queue, resolves `closed`. */
    const settle = (close: RtcDef.FlowClose, info: RtcDef.CloseInfo) => {
      if (session.ended) {
        return
      }
      session.ended = true
      observe.record('close', info.reason, close === true ? {} : { error: String(close.error) })
      if (session.generation) {
        teardownGeneration(session.generation)
      }
      for (const record of localRecords) {
        record.entry.end(close)
      }
      localRecords.clear()
      for (const entry of remoteEntries) {
        entry.end(close)
      }
      remoteEntries.clear()
      trackRecords.clear()
      channelsQueue.close(close)
      statesQueue.close(close)
      tracksQueue.close(close)
      sessionOutages.close()
      closedResolvers.resolve(info)
      observe.close(close)
      notifyDial()
    }

    /** A generation died mid-flight: tear it down, then either hand the outage to the
     * session-reconnect supervisor (local channels suspend for the rebind, remote handles close
     * cleanly — fresh ones re-emit after the redial) or settle the whole session. */
    const endGeneration = (
      generation: Helpers.Generation,
      failure: Result.Failure<unknown>,
      info: RtcDef.CloseInfo,
    ) => {
      if (!generation.alive) {
        return
      }
      teardownGeneration(generation)
      if (session.ended || session.closedByClient) {
        return
      }
      if (reconnect && !session.signalEnded) {
        for (const record of localRecords) {
          record.entry.suspend()
        }
        for (const record of trackRecords) {
          record.sender = undefined // the dead generation's sender — re-added on the redial
        }
        for (const entry of remoteEntries) {
          entry.end(true)
        }
        remoteEntries.clear()
        sessionOutages.add(failure)
        return
      }
      settle(failure, info)
    }

    const sendFrame = (frame: RtcDef.SignalFrame) => signal.send(frame)

    /** Dial ONE generation: construct, wire, adopt as current, recreate every local channel on
     * it, kick negotiation. Returns an error message when construction itself failed. */
    const dialGeneration = (): string | undefined => {
      const generation: Helpers.Generation = {
        pc: undefined as unknown as RtcDef.PeerLike,
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
      }

      let pc: RtcDef.PeerLike
      try {
        pc = new Ctor({
          ...options.configuration,
          ...(options.iceServers ? { iceServers: options.iceServers } : {}),
        })
      } catch (error) {
        counters.failures += 1
        observe.record('error', 'construct', {
          error: error instanceof Error ? error.message : String(error),
        })
        return error instanceof Error ? error.message : String(error)
      }
      generation.pc = pc
      observe.generation += 1
      counters.generations += 1
      observe.record('dial')

      // on* assignment (not addEventListener): PeerLike is the handler-property shape shared by
      // the browser RTCPeerConnection and the node-datachannel polyfill.
      pc.onconnectionstatechange = () => {
        if (!generation.alive || session.ended) {
          return
        }
        const current = pc.connectionState
        statesQueue.add(current)
        observe.record('state', current)
        if (current === 'connected' && counters.connectedMs === undefined) {
          counters.connectedMs = Date.now() - counters.startedAt
        }
        if (current === 'failed') {
          counters.failures += 1
        }
        if (current === 'failed') {
          if (restart) {
            generation.outages.add(current) // hand the outage to the ICE-restart supervisor
          } else {
            endGeneration(
              generation,
              fail('rtc/connection', 'peer connection failed') as Result.Failure<unknown>,
              { state: current, reason: 'failed' },
            )
          }
        } else if (current === 'closed' && !session.closedByClient) {
          if (reconnect) {
            endGeneration(
              generation,
              fail(
                'rtc/connection',
                'the implementation closed the connection',
              ) as Result.Failure<unknown>,
              { state: current, reason: 'closed' },
            )
          } else {
            settle(true, { state: current, reason: 'closed' })
          }
        }
      }
      pc.onicecandidate = event => {
        if (generation.alive && !session.ended) {
          generation.candidatesOut.add(event.candidate ?? null)
        }
      }
      pc.ondatachannel = event => {
        if (generation.alive && !session.ended) {
          generation.incoming.add(event.channel)
        }
      }
      pc.onnegotiationneeded = () => {
        if (!generation.alive || session.ended) {
          return
        }
        if (generation.kicked) {
          generation.kicked = false // our own channel kick already queued this negotiation
          return
        }
        generation.negotiations.add({ kind: 'needed' })
      }
      pc.ontrack = event => {
        if (generation.alive && !session.ended) {
          tracksQueue.add({ track: event.track, streams: event.streams ?? [] })
          counters.tracksReceived += 1
          observe.record('track', `in:${event.track.kind}`)
        }
      }

      session.generation = generation

      // recreate every locally-opened channel on the fresh connection — same handles, new natives
      for (const record of localRecords) {
        try {
          record.entry.rebind(pc.createDataChannel(record.label, initOf(record.options)))
        } catch {
          // an unconstructable channel surfaces through its own flows when the session settles
        }
      }
      // re-add every live local track — media always renegotiates, so its kick covers channels
      let liveTracks = 0
      for (const record of trackRecords) {
        if (record.removed || !record.track) {
          continue
        }
        try {
          record.sender = pc.addTrack?.(record.track, ...record.streams)
          liveTracks += 1
        } catch {
          // an unaddable track surfaces through the negotiation path
        }
      }
      if (liveTracks > 0) {
        generation.kicked = true
        generation.negotiations.add({ kind: 'track' })
      } else if (localRecords.size > 0) {
        generation.kicked = true
        generation.negotiations.add({ kind: 'channel' })
      }

      notifyDial()
      return undefined
    }

    /** Park until a live generation exists (returns it), or the session ends (undefined). */
    function* awaitGeneration(): Operation<Helpers.Generation | undefined> {
      while (!session.ended) {
        const generation = session.generation
        if (generation?.alive) {
          return generation
        }
        yield* dialGate.operation
      }
      return undefined
    }

    /** Run `body` once per live generation, in dial order, until the session ends. `body` must
     * return when its generation dies (every per-generation queue closes on teardown). */
    function* eachGeneration(
      body: (generation: Helpers.Generation) => Operation<void>,
    ): Operation<void> {
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
    }

    function* flushCandidates(generation: Helpers.Generation): Operation<void> {
      while (generation.pendingCandidates.length > 0) {
        const candidate = generation.pendingCandidates.shift()
        // failures are swallowed: candidates from a discarded (glare-ignored) offer routinely fail
        yield* attempt(() => until(generation.pc.addIceCandidate(candidate ?? undefined)))
      }
    }

    /** Count every candidate; record the first of each type per generation and direction. */
    const noteCandidate = (direction: 'in' | 'out', candidate: RtcDef.CandidateLike | null) => {
      const detail = `${direction}:${candidateTypeOf(candidate)}`
      const key = `${observe.generation}:${detail}`
      if (!seenCandidates.has(key)) {
        seenCandidates.add(key)
        observe.record('candidate', detail)
      }
    }

    function* handleCandidate(
      generation: Helpers.Generation,
      candidate: RtcDef.CandidateLike | null,
    ): Operation<void> {
      counters.candidatesReceived += 1
      noteCandidate('in', candidate)
      if (!hasDescription(generation.pc.remoteDescription)) {
        generation.pendingCandidates.push(candidate) // too early — flushed after setRemoteDescription
        return
      }
      yield* attempt(() => until(generation.pc.addIceCandidate(candidate ?? undefined)))
    }

    const failNegotiation = (generation: Helpers.Generation, detail: string) => {
      counters.failures += 1
      observe.record('error', detail, { error: 'rtc/negotiation' })
      endGeneration(generation, fail('rtc/negotiation', detail) as Result.Failure<unknown>, {
        state: generation.pc.connectionState,
        reason: 'negotiation',
      })
    }

    // Perfect negotiation, receive side: an incoming offer is accepted unless we are impolite
    // mid-offer (glare → ignored); the polite side rolls its own offer back first. An incoming
    // answer is applied only while one of our offers is actually outstanding.
    function* handleDescription(
      generation: Helpers.Generation,
      description: RtcDef.DescriptionLike,
    ): Operation<void> {
      const pc = generation.pc
      if (description.type === 'offer') {
        const startedAt = Date.now()
        counters.offersReceived += 1
        observe.record('offer', 'in')
        const ready =
          !generation.makingOffer &&
          (pc.signalingState === 'stable' || generation.settingRemoteAnswer)
        if (!ready) {
          counters.glare += 1
          observe.record('glare', polite ? 'rollback' : 'ignored')
        }
        generation.ignoreOffer = !polite && !ready
        if (generation.ignoreOffer) {
          return
        }
        // polite glare: hand the offer STRAIGHT to setRemoteDescription — modern impls roll the
        // in-flight local offer back implicitly and atomically. An EXPLICIT
        // setLocalDescription({type:'rollback'}) first looks equivalent but kills ICE gathering
        // in Chromium (the rolled-back session never trickles another candidate), so it is only
        // the FALLBACK for strict impls that refuse the direct apply.
        let applied = yield* attempt(() => until(pc.setRemoteDescription(description)))
        if (!isSuccess(applied) && !ready) {
          yield* attempt(() => until(pc.setLocalDescription({ type: 'rollback' })))
          applied = yield* attempt(() => until(pc.setRemoteDescription(description)))
        }
        if (!isSuccess(applied)) {
          failNegotiation(generation, 'setRemoteDescription(offer) failed')
          return
        }
        yield* flushCandidates(generation)
        const answer = yield* attempt(() => until(pc.createAnswer()))
        if (!isSuccess(answer)) {
          failNegotiation(generation, 'createAnswer failed')
          return
        }
        const set = yield* attempt(() => until(pc.setLocalDescription(answer.value)))
        if (!isSuccess(set)) {
          failNegotiation(generation, 'setLocalDescription(answer) failed')
          return
        }
        const sent = yield* attempt(() =>
          sendFrame({ t: 'rtc:description', description: descriptionOf(answer.value) }),
        )
        if (!isSuccess(sent)) {
          failNegotiation(generation, 'signal send failed for the answer')
          return
        }
        counters.answersSent += 1
        observe.record('answer', 'out', { durationMs: Date.now() - startedAt })
        return
      }
      if (description.type === 'answer') {
        if (pc.signalingState !== 'have-local-offer') {
          return // stale or duplicate answer — nothing is outstanding
        }
        generation.settingRemoteAnswer = true
        const applied = yield* attempt(() => until(pc.setRemoteDescription(description)))
        generation.settingRemoteAnswer = false
        if (!isSuccess(applied)) {
          failNegotiation(generation, 'setRemoteDescription(answer) failed')
          return
        }
        counters.answersReceived += 1
        observe.record('answer', 'in')
        yield* flushCandidates(generation)
      }
      // 'pranswer'/'rollback' never travel over the signal in this contract — ignored
    }

    // Signal pump (forked once, session-lifetime): consumes the signaling flow and dispatches
    // frames to the CURRENT generation (parking through a redial gap so an early frame from the
    // remote's own redial is handled, not dropped). Non-`rtc:*` frames are ignored, so keepalive
    // pings on a shared socket are safe.
    const pumpSignal = operation(function* () {
      const subscription = yield* signal.messages
      while (true) {
        const item = yield* subscription.next()
        if (item.done) {
          session.signalEnded = true
          // an established connection keeps running P2P (though it can no longer renegotiate or
          // redial — a later outage settles the session); an unestablished one can never come up
          if (stateOf() !== 'connected' && !session.closedByClient) {
            settle(
              fail('rtc/signal', 'signal closed during negotiation') as Result.Failure<unknown>,
              { state: stateOf(), reason: 'signal' },
            )
          }
          return
        }
        const frame = frameOf(item.value)
        if (!frame) {
          continue
        }
        if (frame.t === 'rtc:bye') {
          settle(true, { state: stateOf(), reason: 'bye' }) // deliberate hang-up — never redialed
          return
        }
        const generation = yield* awaitGeneration()
        if (!generation) {
          return
        }
        if (frame.t === 'rtc:candidate') {
          yield* handleCandidate(generation, frame.candidate)
          continue
        }
        yield* handleDescription(generation, frame.description)
        if (session.ended) {
          return
        }
      }
    }, 'rtc-signal-pump')

    // Candidate pump (forked): best-effort — a dead signal surfaces through the negotiation path.
    const pumpCandidates = operation(function* () {
      yield* eachGeneration(function* (generation) {
        while (true) {
          const item = yield* generation.candidatesOut.next()
          if (item.done) {
            return
          }
          yield* attempt(() =>
            sendFrame({ t: 'rtc:candidate', candidate: candidateOf(item.value) }),
          )
          counters.candidatesSent += 1
          noteCandidate('out', item.value)
        }
      })
    }, 'rtc-candidate-pump')

    // Negotiation supervisor (forked): serializes every outgoing offer of the current
    // generation. Channel kicks are skipped once both descriptions exist (SCTP is up — channels
    // open in-band); impl-fired renegotiation is skipped mid-negotiation.
    const superviseNegotiation = operation(function* () {
      yield* eachGeneration(function* (generation) {
        const pc = generation.pc
        while (true) {
          const request = yield* generation.negotiations.next()
          if (request.done) {
            return
          }
          const { kind } = request.value
          if (polite && (kind === 'channel' || kind === 'track')) {
            // glare avoidance beyond the spec: browsers mishandle offer rollback (a rolled-back
            // Chromium session stops trickling ICE for good), so the POLITE side briefly yields
            // the floor — a racing remote offer lands first and the guards below (or the
            // have-remote-offer bail) then keep this side from double-offering
            yield* sleep(200)
            if (!generation.alive || session.ended) {
              return
            }
          }
          if (
            kind === 'channel' &&
            hasDescription(pc.localDescription) &&
            hasDescription(pc.remoteDescription)
          ) {
            continue
          }
          if (kind === 'needed' && pc.signalingState !== 'stable') {
            continue
          }
          const startedAt = Date.now()
          generation.makingOffer = true
          const result = yield* attempt(function* () {
            const offer = yield* until(
              pc.createOffer(kind === 'restart' ? { iceRestart: true } : undefined),
            )
            // impl-agnostic glare check: only bail when a REMOTE offer holds the floor. (Do not
            // test for 'stable' — libdatachannel flips to 'have-local-offer' the moment a
            // channel is created, long before this offer round runs.)
            if (pc.signalingState === 'have-remote-offer') {
              return false // a remote offer won the race — let the receive side drive
            }
            yield* until(pc.setLocalDescription(offer))
            yield* sendFrame({ t: 'rtc:description', description: descriptionOf(offer) })
            return true
          })
          generation.makingOffer = false
          if (isSuccess(result)) {
            if (result.value) {
              counters.offersSent += 1
              counters.negotiations += 1
              observe.record('offer', `out:${kind}`, { durationMs: Date.now() - startedAt })
            } else {
              counters.glare += 1
              observe.record('glare', `deferred:${kind}`)
            }
          } else if (generation.alive && !session.ended) {
            failNegotiation(generation, 'offer failed')
          }
        }
      })
    }, 'rtc-negotiation')

    // ICE-restart supervisor (forked, only when budgeted): one outage at a time — queue a
    // restart offer, wait `delayMs * backoff^attempt` (capped), check recovery. The budget
    // RESETS after every recovery; exhaustion ends the GENERATION (redialed under `reconnect`,
    // terminal `rtc/ice-exhausted` otherwise).
    const superviseIce = operation(function* (budget: Helpers.Budget) {
      yield* eachGeneration(function* (generation) {
        while (true) {
          const outage = yield* generation.outages.next()
          if (outage.done) {
            return
          }
          if (generation.pc.connectionState === 'connected') {
            continue // a stale outage — the connection already recovered
          }
          let recovered = false
          const startedAt = Date.now()
          for (let attemptNo = 0; attemptNo < budget.retries; attemptNo += 1) {
            if (!generation.alive || session.ended || session.closedByClient) {
              return
            }
            observe.record('ice-restart', `attempt ${attemptNo + 1}`)
            generation.negotiations.add({ kind: 'restart' })
            yield* sleep(delayOf(budget, attemptNo))
            if (!generation.alive || session.ended || session.closedByClient) {
              return
            }
            if (generation.pc.connectionState === 'connected') {
              counters.restarts += 1
              observe.record('ice-restart', 'recovered', { durationMs: Date.now() - startedAt })
              recovered = true
              break
            }
          }
          if (!recovered) {
            endGeneration(
              generation,
              fail(
                'rtc/ice-exhausted',
                `gave up after ${budget.retries} ice restart attempts`,
              ) as Result.Failure<unknown>,
              { state: generation.pc.connectionState, reason: 'ice-exhausted' },
            )
            return
          }
        }
      })
    }, 'rtc-ice-restart')

    // Session-reconnect supervisor (forked, only when budgeted): one generation death at a time —
    // redial a whole new connection over the same signal after `delayMs * backoff^attempt`
    // (capped); success = the new generation reaches `connected` within the next backoff step.
    // The budget RESETS after every recovery; exhaustion settles `rtc/reconnect-exhausted`.
    const superviseReconnect = operation(function* (budget: Helpers.Budget) {
      while (true) {
        const outage = yield* sessionOutages.next()
        if (outage.done) {
          return
        }
        if (session.ended || session.closedByClient) {
          return
        }
        if (session.generation?.alive && session.generation.pc.connectionState === 'connected') {
          continue // a stale outage — a later generation already recovered
        }
        let recovered = false
        const startedAt = Date.now()
        for (let attemptNo = 0; attemptNo < budget.retries; attemptNo += 1) {
          observe.record('redial', `attempt ${attemptNo + 1}`)
          yield* sleep(delayOf(budget, attemptNo))
          if (session.ended || session.closedByClient) {
            return
          }
          if (session.signalEnded) {
            break // no signal, no negotiation — exhaust into the terminal settle below
          }
          const previous = session.generation
          if (previous?.alive) {
            teardownGeneration(previous) // a half-dialed attempt that never connected
          }
          if (dialGeneration() !== undefined) {
            continue // construction failed — next attempt
          }
          // grace window: one backoff step for the fresh generation to negotiate + connect
          yield* sleep(delayOf(budget, attemptNo))
          if (session.ended || session.closedByClient) {
            return
          }
          if (session.generation?.alive && session.generation.pc.connectionState === 'connected') {
            recovered = true
            break
          }
        }
        if (recovered) {
          counters.reconnects += 1
          observe.record('redial', 'recovered', { durationMs: Date.now() - startedAt })
          continue
        }
        settle(
          fail(
            'rtc/reconnect-exhausted',
            `gave up after ${budget.retries} redial attempts`,
          ) as Result.Failure<unknown>,
          { state: stateOf(), reason: 'reconnect-exhausted' },
        )
        return
      }
    }, 'rtc-reconnect')

    // Incoming-channel pump (forked): wrap each remote native, wait for it to OPEN, then emit it
    // on the `channels` flow — consumers never see a half-open channel. Remote handles die with
    // their generation; after a redial the remote side re-announces and fresh handles emit here.
    const pumpIncoming = operation(function* () {
      yield* eachGeneration(function* (generation) {
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
          channelsQueue.add(entry.handle)
          counters.channelsAccepted += 1
          observe.record('channel', `in:${entry.handle.label}`)
        }
      })
    }, 'rtc-incoming-channels')

    // Stats sampler (forked, only when `observe.sampleMs` is set): one `stats` timeline entry per
    // tick, carrying the flattened snapshot — the metrics feed a reporter can pump anywhere.
    const sampleStats = operation(function* (everyMs: number) {
      while (!session.ended) {
        yield* sleep(everyMs)
        const generation = session.generation
        if (session.ended || !generation?.alive) {
          continue
        }
        const snapshot = yield* attempt(() => readStats(generation.pc))
        if (isSuccess(snapshot)) {
          observe.record('stats', undefined, { data: flatten(snapshot.value) })
        }
      }
    }, 'rtc-stats-sampler')

    // initial dial — a construction failure surfaces directly to the connect() caller
    const dialError = dialGeneration()
    if (dialError !== undefined) {
      return yield* fail('rtc/connect', `peer construction failed: ${dialError}`)
    }

    yield* fork(() => pumpSignal())
    yield* fork(() => pumpCandidates())
    yield* fork(() => superviseNegotiation())
    yield* fork(() => pumpIncoming())
    if (restart) {
      const budget = restart
      yield* fork(() => superviseIce(budget))
    }
    if (reconnect) {
      const budget = reconnect
      yield* fork(() => superviseReconnect(budget))
    }
    const sampleMs = options.observe?.sampleMs ?? 0
    if (sampleMs > 0) {
      yield* fork(() => sampleStats(sampleMs))
    }

    const closed = operation(function* () {
      return yield* closedResolvers.operation
    })() as Future<RtcDef.CloseInfo>

    const peer: RtcDef.Peer = {
      get native() {
        return session.generation?.pc as RtcDef.PeerLike
      },
      get connectionState() {
        return stateOf()
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
      id: observe.id,
      get metrics() {
        return observe.metrics(stateOf())
      },
      get timeline() {
        return observe.timeline()
      },
      events: observe.events,
      stats: operation(function* () {
        const generation = session.generation
        if (!generation?.alive) {
          return yield* fail('rtc/stats', 'the peer has no live connection to read stats from')
        }
        return yield* readStats(generation.pc)
      }, 'rtc-stats'),
      // a local channel is a RESOURCE in the CALLER's scope: it closes when that scope does,
      // and the peer's registry force-ends it if the peer settles first. Under `reconnect` the
      // handle is continuous — the peer recreates it on every redialed generation.
      channel: (label: string, channelOptions?: RtcDef.ChannelOptions) =>
        resource(function* (provideChannel) {
          const merged = { ...options.channel, ...channelOptions }
          const generation = yield* awaitGeneration() // parks through a redial gap
          if (!generation || session.ended) {
            return yield* fail('rtc/channel', `peer is closed: cannot open "${label}"`)
          }
          let native: RtcDef.ChannelLike
          try {
            native = generation.pc.createDataChannel(label, initOf(merged))
          } catch (error) {
            return yield* fail(
              'rtc/channel',
              `createDataChannel failed: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
          const entry = wrapChannel(native, merged, {
            ...(options.codec === undefined ? {} : { codec: options.codec }),
            retain: retainLocal,
            observe,
          })
          const record: Helpers.LocalRecord = { entry, label, options: merged }
          localRecords.add(record)
          generation.kicked = true
          generation.negotiations.add({ kind: 'channel' }) // the first channel drives the offer
          try {
            const timeoutMs = merged.openTimeoutMs ?? 10_000
            yield* timeoutMs > 0
              ? race([
                  entry.opened,
                  operation(function* () {
                    yield* sleep(timeoutMs)
                    yield* fail(
                      'rtc/timeout',
                      `channel "${label}" did not open within ${timeoutMs}ms`,
                    )
                  })(),
                ])
              : entry.opened
            counters.channelsOpened += 1
            observe.record('channel', `out:${label}`)
            yield* provideChannel(entry.handle)
          } finally {
            localRecords.delete(record)
            entry.end(true)
          }
        }),
      channels: {
        *[Symbol.iterator]() {
          return channelsQueue
        },
      } as Flow<RtcDef.Channel, RtcDef.FlowClose>,
      // an outgoing track is a RESOURCE in the caller's scope AND a session-stable handle: the
      // peer re-adds it on every redialed generation until it is removed
      addTrack: (track: RtcDef.TrackLike, ...streams: RtcDef.StreamLike[]) =>
        resource(function* (provideSender) {
          const generation = yield* awaitGeneration() // parks through a redial gap
          if (!generation || session.ended) {
            return yield* fail('rtc/track', 'peer is closed: cannot add a track')
          }
          const pc = generation.pc
          if (typeof pc.addTrack !== 'function') {
            return yield* fail(
              'rtc/unsupported',
              'this implementation has no media surface (addTrack) — set a media-capable rtcImpl',
            )
          }
          let sender: RtcDef.SenderLike
          try {
            sender = pc.addTrack(track, ...streams)
          } catch (error) {
            return yield* fail(
              'rtc/track',
              `addTrack failed: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
          const record: Helpers.TrackRecord = {
            track,
            streams: [...streams],
            sender,
            removed: false,
          }
          trackRecords.add(record)
          counters.tracksSent += 1
          observe.record('track', `out:${track.kind}`)
          generation.kicked = true
          generation.negotiations.add({ kind: 'track' }) // media always renegotiates

          const remove = () => {
            if (record.removed) {
              return
            }
            record.removed = true
            trackRecords.delete(record)
            const current = session.generation
            if (
              !session.ended &&
              current?.alive &&
              record.sender &&
              typeof current.pc.removeTrack === 'function'
            ) {
              try {
                current.pc.removeTrack(record.sender)
              } catch {
                // the sender is already gone with its generation
              }
              current.kicked = true
              current.negotiations.add({ kind: 'track' })
            }
            record.sender = undefined
          }

          const handle: RtcDef.Sender = {
            get native() {
              return record.sender
            },
            get track() {
              return record.track
            },
            replace: operation(function* (next: RtcDef.TrackLike | null) {
              if (record.removed || session.ended) {
                return yield* fail('rtc/track', 'sender is gone')
              }
              record.track = next // the next redialed generation adds THIS track
              const active = record.sender
              if (!active) {
                return // mid-redial gap — the rebind will pick the replacement up
              }
              if (typeof active.replaceTrack !== 'function') {
                return yield* fail('rtc/unsupported', 'this implementation has no replaceTrack')
              }
              const swapped = yield* attempt(() =>
                until(active.replaceTrack?.(next) ?? Promise.resolve()),
              )
              if (!isSuccess(swapped)) {
                return yield* fail('rtc/track', 'replaceTrack failed')
              }
            }, 'rtc-replace-track'),
            remove: lift(remove) as () => Operation<void>,
          }

          try {
            yield* provideSender(handle)
          } finally {
            remove()
          }
        }),
      tracks: {
        *[Symbol.iterator]() {
          return tracksQueue
        },
      } as Flow<RtcDef.IncomingTrack, RtcDef.FlowClose>,
      states: {
        *[Symbol.iterator]() {
          return statesQueue
        },
      } as Flow<string, RtcDef.FlowClose>,
      restartIce: lift(() => {
        const generation = session.generation
        if (generation?.alive && !session.ended) {
          generation.negotiations.add({ kind: 'restart' })
        }
      }) as () => Operation<void>,
      close: operation(function* () {
        session.closedByClient = true
        if (!session.ended) {
          yield* attempt(() => sendFrame({ t: 'rtc:bye' }))
          settle(true, { state: stateOf(), reason: 'client' })
        }
        yield* closedResolvers.operation
      }, 'rtc-close'),
      closed,
    }

    try {
      yield* provide(peer)
    } finally {
      // scope teardown: the peer is a resource — say goodbye, close the connection, settle.
      session.closedByClient = true
      if (!session.ended) {
        yield* attempt(() => sendFrame({ t: 'rtc:bye' }))
        settle(true, { state: stateOf(), reason: 'scope closed' })
      }
    }
  })
