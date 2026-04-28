import { operation, useContext } from 'std:effect'

import { Logger } from '../definitions'
import type { Helpers } from '../types/helpers'
import type { LogLevel } from '../utils/level'

import { buildEntry } from './build-entry'
import { dispatch } from './dispatch'

export const logAt = (level: LogLevel) =>
  operation(function* (...args: Helpers.LogPayload[]) {
    const ctx = yield* useContext(Logger)
    if (level < ctx.level) {
      return
    }
    const entry = buildEntry(ctx, level, args)
    yield* dispatch(entry)
  })
