import type { Writable } from 'node:stream'

import type { LEVEL } from './const'

export type Options = {
  scope?: string | null
  plain?: boolean
  disabled?: boolean
  level?: LEVEL

  stream?: Writable
}
