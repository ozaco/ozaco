import type { Helpers } from '../types/helpers'
import type { OtlpDef } from '../types/otlp'

import { CONTENT_TYPES } from './const'
import { jsonMetrics } from './json'
import { protobufMetrics } from './protobuf'
import { groupByResource } from './resource'

/** The meter's entries as ONE OTLP `ExportMetricsServiceRequest` (grouped per resource). */
export const encodeMetrics = (
  entries: readonly Helpers.Entry<Helpers.Metric>[],
  encoding: OtlpDef.Encoding,
  resource: OtlpDef.ResourceAttributes,
): OtlpDef.Encoded => {
  const groups = groupByResource(entries, resource)

  return {
    body: encoding === 'json' ? jsonMetrics(groups) : protobufMetrics(groups),
    contentType: CONTENT_TYPES[encoding],
    items: entries.reduce((sum, entry) => sum + entry.item.points.length, 0),
  }
}
