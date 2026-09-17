import { createTags } from 'std:shared'

export const LoggerErrors = createTags(
  'std:logger',

  /** a transport cannot be set up as asked (a missing log directory with `ensureDir: false`, …). */
  'configuration',
)
