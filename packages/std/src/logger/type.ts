import type { Helpers, Plugin } from 'std:plugin'
import type { Expand } from 'std:shared'

import type { LEVEL } from './const'
import type { extendableTransport } from './create-transport'
import type { createLogger } from './plugin'

export type Options = {
  level?: LEVEL
  scope?: string | null
  disabled?: boolean
  noConsole?: boolean
  date?: (() => string) | boolean
}

export type Context = Expand<
  Required<
    Options & {
      getScope: null | (() => string)
      getDate: null | (() => string)
    }
  >
>

export type LoggerPlugin = ReturnType<typeof createLogger>

export type TransportOptions = {
  level?: LEVEL
  logger?: LoggerPlugin
  disabled?: boolean
}

export type TransportContext = Expand<
  Required<Omit<TransportOptions, 'logger'>> & {
    logger: null | Context
  }
>

export type ExtendableTransport = typeof extendableTransport

export type AnyTransport = Plugin<
  {
    namespace: 'cli/logger'
    name: string
    version: string
  },
  Helpers.InferDefinitions<ExtendableTransport>
>
