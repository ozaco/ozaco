import type { Signal } from 'std:effect'
import { createSignal } from 'std:effect'

import type { Helpers } from '../types/helpers'
import type { RtcDef } from '../types/rtc'

// The peer's observability spine: a bag of integer counters, a bounded ring of timeline entries,
// and a live signal of the same entries. Everything here is synchronous and allocation-light —
// it runs inside impl event handlers, so it must never yield and never grow without bound.

const DEFAULT_TIMELINE = 128

/** A short, human-readable session id (`crypto.randomUUID` is absent outside secure contexts). */
const newId = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.()
  return `rtc_${uuid ? uuid.slice(0, 8) : Math.random().toString(36).slice(2, 10)}`
}

/** Payload size in bytes — exact for binary frames, character count for text ones. */
export const sizeOf = (payload: unknown): number => {
  if (typeof payload === 'string') {
    return payload.length
  }
  if (payload instanceof ArrayBuffer) {
    return payload.byteLength
  }
  return ArrayBuffer.isView(payload) ? payload.byteLength : 0
}

/** `a=candidate:… typ srflx …` → `srflx` (the one field of a candidate worth counting). */
export const candidateTypeOf = (candidate: RtcDef.CandidateLike | null): string => {
  if (!candidate?.candidate) {
    return 'end'
  }
  return /\btyp (?<type>\w+)/u.exec(candidate.candidate)?.groups?.['type'] ?? 'candidate'
}

export const createObserver = (options?: RtcDef.ObserveOptions): Helpers.Observer => {
  const limit = options?.timeline ?? DEFAULT_TIMELINE
  const signal: Signal<RtcDef.Event, RtcDef.FlowClose> = createSignal<
    RtcDef.Event,
    RtcDef.FlowClose
  >()
  const entries: RtcDef.Event[] = []

  const counters: RtcDef.Metrics = {
    id: newId(),
    startedAt: Date.now(),
    state: 'new',
    generations: 0,
    negotiations: 0,
    offersSent: 0,
    offersReceived: 0,
    answersSent: 0,
    answersReceived: 0,
    glare: 0,
    candidatesSent: 0,
    candidatesReceived: 0,
    restarts: 0,
    reconnects: 0,
    channelsOpened: 0,
    channelsAccepted: 0,
    messagesSent: 0,
    messagesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    tracksSent: 0,
    tracksReceived: 0,
    failures: 0,
  }

  const observer: Helpers.Observer = {
    id: counters.id,
    counters,
    generation: 0,
    events: signal,

    record(kind, detail, extra) {
      const event: RtcDef.Event = {
        at: Date.now(),
        generation: observer.generation,
        kind,
        ...(detail === undefined ? {} : { detail }),
        ...(extra?.durationMs === undefined ? {} : { durationMs: extra.durationMs }),
        ...(extra?.error === undefined ? {} : { error: extra.error }),
        ...(extra?.data === undefined ? {} : { data: extra.data }),
      }
      if (limit > 0) {
        entries.push(event)
        if (entries.length > limit) {
          entries.shift()
        }
      }
      signal.send(event) // lossy on purpose: no subscriber, no buffer
    },

    timeline: () => entries,

    metrics: state => ({ ...counters, state }),

    close: close => {
      signal.close(close)
    },
  }

  return observer
}
