import { createTags } from 'std:shared'

/** What a sink call can fail with — never seen by traced code (telemetry never fails it). */
export const TraceErrors = createTags(
  'std:trace',

  'tracer',
)

/** The cause names trace stamps on its telemetry calls. */
export const TraceCauses = createTags(
  'std:trace',

  'export',
  'emit',
)
