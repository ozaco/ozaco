import type { AnyType } from 'std:shared'

import { EVENT } from '../const'
import type { EventSource, EventSourceMap } from '../types'

export const isEventEmitter = <T extends EventSourceMap = AnyType>(
  value: unknown,
): value is EventSource<T> =>
  typeof value === 'object' && value !== null && '_t' in value && value._t === EVENT
