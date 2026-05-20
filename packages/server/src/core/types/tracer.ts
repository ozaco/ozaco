import type { Future } from 'std:effect'
import type { Result } from 'std:result'

export namespace TracerDef {
  export interface Options {
    onSpanEnd?: (snapshot: SpanSnapshot) => void
  }

  export interface Context {
    name: string
    onSpanEnd?: (snapshot: SpanSnapshot) => void
  }

  export type SpanAttributeValue =
    | string
    | number
    | boolean
    | readonly string[]
    | readonly number[]
    | readonly boolean[]
    | undefined

  export type SpanAttributes = Record<string, SpanAttributeValue>

  export interface SpanContext {
    traceId: string
    spanId: string
    traceFlags: number
    parentSpanId?: string
    isRemote?: boolean
  }

  export interface SpanStatus {
    code: 0 | 1 | 2
    message?: string
    cause?: string[]
  }

  export interface SpanOptions {
    kind?: 0 | 1 | 2 | 3 | 4 | 5
    attributes?: SpanAttributes
    startTime?: number
    root?: boolean
  }

  export interface SpanEvent {
    name: string
    attributes?: SpanAttributes
    time?: number
  }

  export interface Span {
    spanContext(): Future<SpanContext, unknown>
    setAttribute(key: string, value: SpanAttributeValue): Future<Span, unknown>
    setAttributes(attributes: SpanAttributes): Future<Span, unknown>
    setStatus(status: SpanStatus): Future<Span, unknown>
    updateName(name: string): Future<Span, unknown>
    addEvent(name: string, attributes?: SpanAttributes, startTime?: number): Future<Span, unknown>
    recordException(exception: Result.Failure<unknown>, time?: number): Future<void, unknown>
    end(endTime?: number): Future<void, unknown>
    isRecording(): Future<boolean, unknown>
  }

  export interface SpanSnapshot {
    name: string
    context: SpanContext
    kind?: number
    status: SpanStatus
    attributes: SpanAttributes
    events: ReadonlyArray<SpanEvent>
    startTime: number
    endTime: number
  }

  export interface Actions {
    startSpan(name: string, options?: SpanOptions): Future<Span, unknown>
  }
}
