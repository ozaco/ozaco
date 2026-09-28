import type { TraceDef } from '../types/trace'

import { INVALID_SPAN_ID, INVALID_TRACE_ID } from './const'
import { isValidContext } from './propagation'
import type { SpanRecorder } from './recorder'
import { recordChecked } from './settle'

const INVALID_CONTEXT: TraceDef.SpanContext = Object.freeze({
  traceId: INVALID_TRACE_ID,
  spanId: INVALID_SPAN_ID,
  flags: 0,
})

/** What a span body gets: a thin face over the recorder (the recorder itself stays internal). */
export const handleOf = (rec: SpanRecorder): TraceDef.SpanHandle => ({
  context: rec.context,
  valid: isValidContext(rec.context),
  recording: rec.recording,

  setAttributes: input => rec.setAttributes(input),
  setAttribute: (key, value) => rec.setAttributes({ [key]: value }),
  addEvent: (name, input, time) => rec.addEvent(name, input, time),
  addLink: (context, input) => rec.addLink(context, input),
  setStatus: status => rec.setStatus(status),
  updateName: name => rec.updateName(name),
  recordFailure: (failure, options) => recordChecked(rec, failure, options),
})

/** The handle when there is no span: an invalid context, nothing recorded — except that
 * `recordFailure` still emits the exception log record (no span context) while tracing is on, and
 * hands it to the process fallback sink (if any) while tracing is off. */
export const NOOP_HANDLE: TraceDef.SpanHandle = Object.freeze({
  context: INVALID_CONTEXT,
  valid: false,
  recording: false,

  setAttributes() {},
  setAttribute() {},
  addEvent() {},
  addLink() {},
  setStatus() {},
  updateName() {},
  recordFailure: (failure, options) => recordChecked(null, failure, options),
} satisfies TraceDef.SpanHandle)
