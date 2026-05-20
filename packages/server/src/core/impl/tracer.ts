import { operation, useContext } from 'std:effect'

import { Tracer } from '../definitions'
import { getSpanId, getTraceId } from '../internal/id'
import type { TracerDef } from '../types/tracer'
import { TraceContext } from '../utils/context'

const DefaultTracerImpl = Tracer.implement({
  name: 'server/default-tracer',
  version: '0.0.0',
  *setup(options: TracerDef.Options = {}) {
    return {
      name: 'default-tracer',
      ...(options.onSpanEnd ? { onSpanEnd: options.onSpanEnd } : {}),
    }
  },
})

export const DefaultTracer = DefaultTracerImpl.build({
  startSpan: operation(function* (name: string, spanOptions: TracerDef.SpanOptions = {}) {
    const tracerCtx = yield* useContext(DefaultTracerImpl)
    const parent = spanOptions.root ? undefined : yield* TraceContext.get()

    const traceId = parent?.traceId ?? (yield* getTraceId())
    const spanId = yield* getSpanId()

    const spanContextValue: TracerDef.SpanContext = {
      traceId,
      spanId,
      traceFlags: parent?.traceFlags ?? 1,
      ...(parent ? { parentSpanId: parent.spanId } : {}),
    }

    const attributes: Record<string, TracerDef.SpanAttributeValue> = {
      ...spanOptions.attributes,
    }
    const events: TracerDef.SpanEvent[] = []
    let currentName = name
    let status: TracerDef.SpanStatus = { code: 0 }
    const startTime = spanOptions.startTime ?? performance.now()
    let endTime: number | undefined

    const span: TracerDef.Span = {
      spanContext: operation(function* () {
        return spanContextValue
      }),

      setAttribute: operation(function* (key: string, value: TracerDef.SpanAttributeValue) {
        attributes[key] = value
        return span
      }),

      setAttributes: operation(function* (attrs: TracerDef.SpanAttributes) {
        Object.assign(attributes, attrs)
        return span
      }),

      setStatus: operation(function* (next: TracerDef.SpanStatus) {
        status = next
        return span
      }),

      updateName: operation(function* (next: string) {
        currentName = next
        return span
      }),

      addEvent: operation(function* (
        eventName: string,
        eventAttrs?: TracerDef.SpanAttributes,
        time?: number,
      ) {
        events.push({
          name: eventName,
          ...(eventAttrs ? { attributes: eventAttrs } : {}),
          ...(time === undefined ? {} : { time }),
        })
        return span
      }),

      recordException: operation(function* (exception, time) {
        events.push({
          name: 'exception',
          attributes: {
            'exception.message': exception.message,
            ...(exception.causes ? { 'exception.causes': exception.causes } : {}),
          },
          ...(time === undefined ? {} : { time }),
        })
      }),

      end: operation(function* (when?: number) {
        if (endTime === undefined) {
          endTime = when ?? performance.now()
        } else {
          return
        }

        tracerCtx.onSpanEnd?.({
          name: currentName,
          context: spanContextValue,
          ...(spanOptions.kind === undefined ? {} : { kind: spanOptions.kind }),
          status,
          attributes,
          events,
          startTime,
          endTime,
        })
      }),

      isRecording: operation(function* () {
        return endTime === undefined
      }),
    }

    return span
  }),
})
