import { operation } from 'std:effect'
import type { LoggerDef } from 'std:logger'

import { pushLog } from './metric'

/** The metrics logger transport's `write` — buffers every log entry into the metrics `logs` store; the
 * entry's structured `bindings` + `data` become the record's custom `meta`. Wired into the
 * `MetricsLogTransport` plugin in ./definition. */
export const writeAction = operation(function* (entry: LoggerDef.Entry) {
  const meta = { ...entry.bindings, ...entry.data }
  pushLog({
    ts: entry.time,
    level: entry.level,
    msg: entry.msg,
    error: entry.error,
    meta: Object.keys(meta).length > 0 ? meta : undefined,
  })
})
