import { call, operation, useContext } from 'std:effect'

import { PostgresStateRef } from '../impl'

export const closeAction = operation(function* () {
  const state = yield* useContext(PostgresStateRef)
  yield* call(() => state.close())
})
