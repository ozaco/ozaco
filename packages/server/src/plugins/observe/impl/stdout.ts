import type { ObserveDef } from 'server:core'
import { ObserveExporter } from 'server:core'

import pkg from '../../../../package.json'
import { mirror } from '../internal/mirror'

const StdoutExporterImpl = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
  name: 'server-observe-stdout',
  version: pkg.version,
  description: 'Every span and log record on stdout (dev)',

  *setup() {
    return { exporter: 'stdout' }
  },
})

/**
 * The stdout exporter (dev) — `plugins: [StdoutExporter]`: EVERY finished span (one compact line
 * with `trace_id=` / `span_id=`, its events and links indented under it) and EVERY log record (an
 * exception with its full cause chain indented under it) as it happens — the same records every
 * other sink receives. Nothing is batched or kept.
 */
export const StdoutExporter = StdoutExporterImpl.build({
  *export(event: ObserveDef.Event) {
    mirror(event)
  },
  *start() {},
  *flush() {},
})
