import type { Helpers } from 'std:plugin'
import { nop } from 'std:shared'

import type { log } from './log'

type Result = Helpers.InferDefinitionValue<typeof log>

export const fakeLog: Result = {
  trace: nop as Result['trace'],
  debug: nop as Result['debug'],
  info: nop as Result['info'],
  success: nop as Result['success'],
  warn: nop as Result['warn'],
  error: nop as Result['error'],
  fatal: nop as Result['fatal'],
}
