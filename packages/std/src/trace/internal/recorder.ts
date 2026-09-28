import type { Scope } from 'std:effect'
import type { Result } from 'std:result'
import { capUtf8 } from 'std:shared'

import type { Helpers } from '../types/helpers'
import type { TraceDef } from '../types/trace'

import { attributesOf, entriesOf } from './attributes'
import { anchorNow, timeOf } from './clock'
import {
  EXCEPTION_EVENT,
  MAX_ATTRIBUTES,
  MAX_EVENTS,
  MAX_LINKS,
  MAX_VALUE_BYTES,
  RECORDER_BRAND,
} from './const'
import { handleOf } from './handle'
import { plainContext } from './tree'

const UNSET: TraceDef.Status = Object.freeze({ code: 'unset' })

const openers = new WeakMap<Scope, object>()

/** The token standing for `scope` in the recorders opened there (weakly keyed: no retention). */
export const openerOf = (scope: Scope): object => {
  let token = openers.get(scope)

  if (!token) {
    token = {}
    openers.set(scope, token)
  }

  return token
}

/**
 * The state shared by every span of ONE local trace — a local root (no parent, or a remote one)
 * and its in-process descendants: the anchored clock, the failures waiting to settle, and the
 * `record: 'errors'` buffer.
 */
export class LocalTrace {
  readonly anchor: Helpers.Anchor = anchorNow()
  readonly pending = new Map<Result.Failure<unknown>, Helpers.Pending>()
  readonly mode: 'always' | 'errors'
  /** `open` while an `'errors'` trace buffers; `keep` exports as spans end; `drop` discards. */
  decision: 'open' | 'keep' | 'drop'
  /** A failure settled / was recorded in this local trace. */
  failed = false
  readonly spans: TraceDef.SpanData[] = []
  readonly logs: TraceDef.LogData[] = []

  constructor(mode: 'always' | 'errors') {
    this.mode = mode
    this.decision = mode === 'errors' ? 'open' : 'keep'
  }

  now(): number {
    return timeOf(this.anchor)
  }
}

/**
 * One span. A CLASS instance, never a plain object: `ActiveSpan` is a snapshot context and a
 * snapshot copies plain objects into every fork, so a fork's `setStatus` would land on a copy.
 * With `trace === null` it is a PASS-THROUGH: an inbound context carried unchanged while tracing
 * is off, nothing recorded.
 */
export class SpanRecorder implements TraceDef.ActiveRecorder {
  readonly [RECORDER_BRAND] = true

  readonly context: TraceDef.SpanContext
  readonly parent: TraceDef.SpanContext | null
  /** The in-process parent span (`null` for a local root). */
  readonly local: SpanRecorder | null
  readonly trace: LocalTrace | null
  readonly kind: TraceDef.SpanKind
  readonly scope: TraceDef.InstrumentationScope
  readonly service: string | null
  readonly recording: boolean
  readonly failure: TraceDef.FailureOptions | undefined
  readonly start: number
  /** A token of the scope (task) the span was opened in (never the scope itself — an ended span
   * must not keep its task's contexts alive): a failure escaping a span of the SAME task and still
   * pending when this one is halted was caught by its body (it would have failed it otherwise). */
  readonly opener: object | null

  name: string
  end = 0
  ended = false
  exported = false
  /** Waiting for a failure it ended with (or unwound with) to settle. */
  held = false
  status: TraceDef.Status = UNSET

  readonly attributes = new Map<string, TraceDef.AttrValue>()
  droppedAttributes = 0
  readonly events: TraceDef.SpanEvent[] = []
  droppedEvents = 0
  readonly links: TraceDef.Link[] = []
  droppedLinks = 0

  #handle: TraceDef.SpanHandle | undefined

  constructor(init: Helpers.RecorderInit, trace: LocalTrace | null) {
    this.name = init.name
    this.context = init.context
    this.parent = init.parent
    this.local = init.local
    this.trace = trace
    this.kind = init.kind
    this.scope = init.scope
    this.service = init.service
    this.recording = init.recording && trace !== null
    this.failure = init.failure
    this.start = init.start
    this.opener = init.opener
  }

  /** An inbound context carried as-is while tracing is off. */
  static passThrough(context: TraceDef.SpanContext): SpanRecorder {
    return new SpanRecorder(
      {
        name: '',
        context: { ...context, flags: context.flags & 0x03, remote: context.remote ?? true },
        parent: null,
        local: null,
        kind: 'server',
        scope: { name: '' },
        service: null,
        recording: false,
        start: 0,
        failure: undefined,
        opener: null,
      },
      null,
    )
  }

  get handle(): TraceDef.SpanHandle {
    this.#handle ??= handleOf(this)

    return this.#handle
  }

  get passThrough(): boolean {
    return this.trace === null
  }

  /** Mutations from span code land only while the span records and has not ended. */
  get open(): boolean {
    return this.recording && !this.ended
  }

  /** Now on its trace's clock — for a pass-through, the clock a new local root anchors to. */
  now(): number {
    return this.trace ? this.trace.now() : timeOf(anchorNow())
  }

  setAttributes(input: TraceDef.AttributesInput | undefined): void {
    if (!this.open) {
      return
    }

    for (const [key, value] of entriesOf(input, MAX_VALUE_BYTES)) {
      if (this.attributes.has(key) || this.attributes.size < MAX_ATTRIBUTES) {
        this.attributes.set(key, value)
      } else {
        this.droppedAttributes += 1
      }
    }
  }

  /** The recorder's own bookkeeping (`error.type`, `ozaco.cancelled`): past the cap and the end. */
  mark(key: string, value: TraceDef.AttrValue): void {
    if (this.recording) {
      this.attributes.set(key, value)
    }
  }

  addEvent(name: string, input?: TraceDef.AttributesInput, time?: number): void {
    if (!this.open) {
      return
    }

    if (this.events.length >= MAX_EVENTS) {
      this.droppedEvents += 1

      return
    }

    this.events.push(eventOf(name, input, time ?? this.now()))
  }

  /**
   * The `exception` event of a failure recorded here. It outranks the span code's own events: at
   * the cap the latest non-exception event gives way (counted dropped); only a span already full
   * of exceptions drops the new one.
   */
  pushException(attributes: TraceDef.Attributes, time: number): void {
    if (!this.recording) {
      return
    }

    if (this.events.length >= MAX_EVENTS) {
      const at = this.events.findLastIndex(item => item.name !== EXCEPTION_EVENT)

      this.droppedEvents += 1

      if (at === -1) {
        return
      }

      this.events.splice(at, 1)
    }

    // under the span limits like every event (a whole chain would otherwise ride unbounded)
    this.events.push(eventOf(EXCEPTION_EVENT, attributes, time))
  }

  addLink(context: TraceDef.SpanContext, input?: TraceDef.AttributesInput): void {
    if (!this.open) {
      return
    }

    if (this.links.length >= MAX_LINKS) {
      this.droppedLinks += 1

      return
    }

    this.links.push(linkOf(context, input))
  }

  setStatus(status: TraceDef.Status): void {
    if (!this.open) {
      return
    }

    this.status =
      status.code === 'error'
        ? {
            code: 'error',
            ...(status.message ? { message: capUtf8(status.message, MAX_VALUE_BYTES) } : {}),
          }
        : UNSET
  }

  /** The settled failure's status — a status the span code set itself is kept. */
  fail(message: string): void {
    if (this.recording && this.status.code === 'unset') {
      this.status = {
        code: 'error',
        ...(message ? { message: capUtf8(message, MAX_VALUE_BYTES) } : {}),
      }
    }
  }

  updateName(name: string): void {
    if (this.open && name) {
      this.name = name
    }
  }

  toSpanData(): TraceDef.SpanData {
    const { context } = this

    return {
      context: {
        traceId: context.traceId,
        spanId: context.spanId,
        flags: context.flags,
        ...(context.state ? { state: context.state } : {}),
      },
      parent: this.parent,
      name: this.name,
      kind: this.kind,
      service: this.service,
      scope: this.scope,
      start: this.start,
      end: this.end,
      attributes: Object.fromEntries(this.attributes),
      droppedAttributes: this.droppedAttributes,
      // by time (stable: same-time events keep their order): an exception recorded at the
      // failure's own time lands among the span code's events, in every sink alike
      events: this.events.toSorted((left, right) => left.time - right.time),
      droppedEvents: this.droppedEvents,
      links: [...this.links],
      droppedLinks: this.droppedLinks,
      status: this.status,
    }
  }
}

/** A span event, its attributes normalized under the per-event limits. */
export const eventOf = (
  name: string,
  input: TraceDef.AttributesInput | undefined,
  time: number,
): TraceDef.SpanEvent => {
  if (!input) {
    return { name, time }
  }

  const { attributes, dropped } = attributesOf(input, MAX_VALUE_BYTES, MAX_ATTRIBUTES)

  return { name, time, attributes, ...(dropped > 0 ? { droppedAttributes: dropped } : {}) }
}

/** A link, its attributes normalized under the per-link limits. */
export const linkOf = (
  context: TraceDef.SpanContext,
  input: TraceDef.AttributesInput | undefined,
): TraceDef.Link => {
  const target = plainContext(context)

  if (!input) {
    return { context: target }
  }

  const { attributes, dropped } = attributesOf(input, MAX_VALUE_BYTES, MAX_ATTRIBUTES)

  return {
    context: target,
    attributes,
    ...(dropped > 0 ? { droppedAttributes: dropped } : {}),
  }
}
