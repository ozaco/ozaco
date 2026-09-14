import { createTags } from 'std:shared'

/** The cause names Resilience appends to the server failures it raises. */
export const ResilienceCauses = createTags(
  'server:resilience',

  'timeout',
  'breaker',
  'bulkhead',
  'rate-limit',
)
