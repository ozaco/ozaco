import type { Writable } from 'node:stream'

import type { LEVEL } from './const'
import type { createLogger } from './plugin'

export type Options = {
  scope?: string | null
  plain?: boolean
  disabled?: boolean
  level?: LEVEL

  stream?: Writable
}

export type LoggerPlugin = ReturnType<typeof createLogger>
