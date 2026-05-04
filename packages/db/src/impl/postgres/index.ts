import { closeAction } from './actions/close'
import { PostgresImpl } from './impl'

export type { PostgresConfig } from './types'

export const PostgresDB = PostgresImpl.build({
  close: closeAction,
})
