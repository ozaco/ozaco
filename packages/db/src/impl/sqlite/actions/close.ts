import { call, operation, useContext } from 'std:effect'

import { SqliteStateRef } from '../impl'

export const closeAction = operation(function* () {
  const state = yield* useContext(SqliteStateRef)
  yield* call(() => {
    state.raw.close()
  })
})
