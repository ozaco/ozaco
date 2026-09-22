import type { ObserveDef } from 'server:core'
import { ObserveExporter } from 'server:core'

import pkg from '../../../../package.json'
import { mirror } from '../internal/mirror'

const StdoutExporterImpl = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
  name: 'server-observe-stdout',
  version: pkg.version,
  description: 'One stdout line per request, failure and log (dev)',

  *setup() {
    return { exporter: 'stdout' }
  },
})

/**
 * The stdout mirror as an exporter — `plugins: [StdoutExporter]`: one `[oz] <requestId> …` line
 * per request, failure and log as it happens, request id first so a request's lines grep
 * together. Nothing is batched or kept.
 */
export const StdoutExporter = StdoutExporterImpl.build({
  *export(event: ObserveDef.Event) {
    mirror(event)
  },
  *start() {},
  *flush() {},
})
