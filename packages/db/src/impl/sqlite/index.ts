import { closeAction } from './actions/close'
import { SqliteImpl } from './impl'

export type { SqliteConfig } from './types'

export const SqliteDB = SqliteImpl.build({
  close: closeAction,
})
