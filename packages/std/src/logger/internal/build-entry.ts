import type { Helpers } from '../types/helpers'
import type { LoggerContext } from '../types/logger'
import type { LogLevel } from '../utils/level'

import { normalizePayload } from './normalize'

export const buildEntry = (
  ctx: LoggerContext,
  level: LogLevel,
  args: readonly Helpers.LogPayload[],
): Helpers.LogEntry => {
  const { msg, data, error } = normalizePayload(args)
  return {
    level,
    time: ctx.timestamp(),
    msg,
    error,
    bindings: ctx.bindings,
    data,
  }
}
