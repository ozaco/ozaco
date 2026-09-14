import type { Operation } from 'std:effect'
import { attempt, operation, sleep, until } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isSuccess } from 'std:result'

import { POLITE_YIELD_MS } from '../const'
import type { Helpers } from '../types/helpers'
import type { RtcDef } from '../types/rtc'

import { descriptionOf, hasDescription } from './signal'

const failNegotiation = (
  session: Helpers.Session,
  generation: Helpers.Generation,
  detail: string,
) => {
  session.counters.failures += 1
  session.observe.record('error', detail, { error: 'rtc/negotiation' })
  session.endGeneration(generation, fail('rtc/negotiation', detail) as Result.Failure<unknown>, {
    state: generation.pc.connectionState,
    reason: 'negotiation',
  })
}

function* flushCandidates(generation: Helpers.Generation): Operation<void> {
  while (generation.pendingCandidates.length > 0) {
    const candidate = generation.pendingCandidates.shift()

    // failures are swallowed: candidates from a discarded (glare-ignored) offer routinely fail
    yield* attempt(() => until(generation.pc.addIceCandidate(candidate ?? undefined)))
  }
}

/**
 * Apply an incoming offer. Polite glare: hand the offer STRAIGHT to setRemoteDescription —
 * modern impls roll the in-flight local offer back implicitly and atomically. An EXPLICIT
 * `setLocalDescription({ type: 'rollback' })` first looks equivalent but kills ICE gathering in
 * Chromium (the rolled-back session never trickles another candidate), so it is only the
 * FALLBACK for strict impls that refuse the direct apply.
 */
function* applyOffer(
  pc: RtcDef.PeerLike,
  description: RtcDef.DescriptionLike,
  ready: boolean,
): Operation<boolean> {
  const applied = yield* attempt(() => until(pc.setRemoteDescription(description)))
  if (isSuccess(applied) || ready) {
    return isSuccess(applied)
  }

  yield* attempt(() => until(pc.setLocalDescription({ type: 'rollback' })))
  const retried = yield* attempt(() => until(pc.setRemoteDescription(description)))

  return isSuccess(retried)
}

function* handleOffer(
  session: Helpers.Session,
  generation: Helpers.Generation,
  description: RtcDef.DescriptionLike,
): Operation<void> {
  const { polite, counters, observe } = session
  const { pc } = generation
  const startedAt = Date.now()

  counters.offersReceived += 1
  observe.record('offer', 'in')

  const ready =
    !generation.makingOffer && (pc.signalingState === 'stable' || generation.settingRemoteAnswer)

  if (!ready) {
    counters.glare += 1
    observe.record('glare', polite ? 'rollback' : 'ignored')
  }

  generation.ignoreOffer = !polite && !ready
  if (generation.ignoreOffer) {
    return
  }

  if (!(yield* applyOffer(pc, description, ready))) {
    failNegotiation(session, generation, 'setRemoteDescription(offer) failed')
    return
  }

  yield* flushCandidates(generation)

  const answer = yield* attempt(() => until(pc.createAnswer()))
  if (!isSuccess(answer)) {
    failNegotiation(session, generation, 'createAnswer failed')
    return
  }

  const set = yield* attempt(() => until(pc.setLocalDescription(answer.value)))
  if (!isSuccess(set)) {
    failNegotiation(session, generation, 'setLocalDescription(answer) failed')
    return
  }

  const sent = yield* attempt(() =>
    session.sendFrame({ t: 'rtc:description', description: descriptionOf(answer.value) }),
  )
  if (!isSuccess(sent)) {
    failNegotiation(session, generation, 'signal send failed for the answer')
    return
  }

  counters.answersSent += 1
  observe.record('answer', 'out', { durationMs: Date.now() - startedAt })
}

function* handleAnswer(
  session: Helpers.Session,
  generation: Helpers.Generation,
  description: RtcDef.DescriptionLike,
): Operation<void> {
  const { pc } = generation

  if (pc.signalingState !== 'have-local-offer') {
    return // stale or duplicate answer — nothing is outstanding
  }

  generation.settingRemoteAnswer = true
  const applied = yield* attempt(() => until(pc.setRemoteDescription(description)))
  generation.settingRemoteAnswer = false

  if (!isSuccess(applied)) {
    failNegotiation(session, generation, 'setRemoteDescription(answer) failed')
    return
  }

  session.counters.answersReceived += 1
  session.observe.record('answer', 'in')

  yield* flushCandidates(generation)
}

/** Whether an offer request should be skipped for the generation's current state. */
const skipOffer = (kind: Helpers.NegotiationRequest['kind'], pc: RtcDef.PeerLike) => {
  // channel kicks are pointless once both descriptions exist: SCTP is up, channels open in-band
  if (kind === 'channel') {
    return hasDescription(pc.localDescription) && hasDescription(pc.remoteDescription)
  }

  // impl-fired renegotiation is skipped mid-negotiation
  return kind === 'needed' && pc.signalingState !== 'stable'
}

/**
 * One outgoing offer round: create, bail if a REMOTE offer holds the floor, set local, send.
 * Resolves `true` when the offer went out, `false` when it deferred to the remote's offer.
 */
function* offer(
  session: Helpers.Session,
  pc: RtcDef.PeerLike,
  kind: Helpers.NegotiationRequest['kind'],
): Operation<boolean> {
  const created = yield* until(
    pc.createOffer(kind === 'restart' ? { iceRestart: true } : undefined),
  )

  // impl-agnostic glare check: only bail when a REMOTE offer holds the floor. (Do not test for
  // 'stable' — libdatachannel flips to 'have-local-offer' the moment a channel is created, long
  // before this offer round runs.)
  if (pc.signalingState === 'have-remote-offer') {
    return false // a remote offer won the race — let the receive side drive
  }

  yield* until(pc.setLocalDescription(created))
  yield* session.sendFrame({ t: 'rtc:description', description: descriptionOf(created) })

  return true
}

/** A remote ICE candidate: applied at once, or buffered until a remote description lands. */
export function* handleCandidate(
  session: Helpers.Session,
  generation: Helpers.Generation,
  candidate: RtcDef.CandidateLike | null,
): Operation<void> {
  session.counters.candidatesReceived += 1
  session.noteCandidate('in', candidate)

  if (!hasDescription(generation.pc.remoteDescription)) {
    generation.pendingCandidates.push(candidate) // too early — flushed after setRemoteDescription
    return
  }

  yield* attempt(() => until(generation.pc.addIceCandidate(candidate ?? undefined)))
}

/**
 * Perfect negotiation, receive side: an incoming offer is accepted unless we are impolite
 * mid-offer (glare → ignored); the polite side rolls its own offer back first. An incoming
 * answer is applied only while one of our offers is actually outstanding. `'pranswer'` /
 * `'rollback'` never travel over the signal in this contract — ignored.
 */
export function* handleDescription(
  session: Helpers.Session,
  generation: Helpers.Generation,
  description: RtcDef.DescriptionLike,
): Operation<void> {
  if (description.type === 'offer') {
    yield* handleOffer(session, generation, description)
  } else if (description.type === 'answer') {
    yield* handleAnswer(session, generation, description)
  }
}

/**
 * Negotiation supervisor (forked): serializes every outgoing offer of the current generation.
 * Channel kicks are skipped once both descriptions exist (SCTP is up — channels open in-band);
 * impl-fired renegotiation is skipped mid-negotiation.
 */
export const superviseNegotiation = operation(function* (session: Helpers.Session) {
  const { polite, counters, observe } = session

  yield* session.eachGeneration(function* (generation) {
    const { pc } = generation

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
        yield* sleep(POLITE_YIELD_MS)

        if (!generation.alive || session.ended) {
          return
        }
      }

      if (skipOffer(kind, pc)) {
        continue
      }

      const startedAt = Date.now()
      generation.makingOffer = true
      const result = yield* attempt(() => offer(session, pc, kind))
      generation.makingOffer = false

      if (!isSuccess(result)) {
        if (generation.alive && !session.ended) {
          failNegotiation(session, generation, 'offer failed')
        }
        continue
      }

      if (result.value) {
        counters.offersSent += 1
        counters.negotiations += 1
        observe.record('offer', `out:${kind}`, { durationMs: Date.now() - startedAt })
      } else {
        counters.glare += 1
        observe.record('glare', `deferred:${kind}`)
      }
    }
  })
}, 'rtc-negotiation')
