import type { Writable } from 'node:stream'
import type { Expand } from 'std:shared'

import type { LEVEL } from './const'
import type { createLogger } from './plugin'

export type Options = {
  scope?: string | null
  noColors?: boolean
  disabled?: boolean
  level?: LEVEL

  stream?: Writable
}

export type Context = Expand<Required<Options>> & {
  scope: null | string
}

export type LoggerPlugin = ReturnType<typeof createLogger>
