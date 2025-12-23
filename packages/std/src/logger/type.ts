import type { Writable } from 'node:stream'
import type { Expand } from 'std:shared'

import type { LEVEL } from './const'
import type { createLogger } from './plugin'

export type Options = {
  level?: LEVEL
  scope?: string | null
  disabled?: boolean

  stream?: Writable
}

export type Context = Expand<Required<Omit<Options, 'scope'>> & {
  scope: null | (() => string)
}>

export type LoggerPlugin = ReturnType<typeof createLogger>
