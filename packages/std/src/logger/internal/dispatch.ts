import { all, operation } from 'std:effect'

import type { Helpers } from '../types/helpers'
import { getTransports } from '../utils/register'

export const dispatch = operation(function* (entry: Helpers.LogEntry) {
  const transports = yield* getTransports()
  if (transports.length === 0) {
    return
  }
  const ops = transports
    .filter(t => t.level === undefined || entry.level >= t.level)
    .map(t => t.transport.actions.write(entry))
  if (ops.length === 0) {
    return
  }
  yield* all(ops)
})
