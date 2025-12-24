import type { Writable } from 'node:stream'
import type { Expand } from 'std:shared'

import type { LEVEL } from './const'
import type { createLogger } from './plugin'

export type Options = {
  level?: LEVEL
  scope?: string | null
  disabled?: boolean
  date?: (() => string) | boolean

  stream?: Writable
}

export type Context = Expand<
  Required<Omit<Options, 'scope' | 'date'>> & {
    scope: null | (() => string)
    date: null | (() => string)
  }
>

export type LoggerPlugin = ReturnType<typeof createLogger>
