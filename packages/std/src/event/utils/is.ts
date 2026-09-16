import type { AnyType } from 'std:shared'

import { EVENT } from '../const'
import type { EventEmitter } from '../types'

export const isEventEmitter = <T extends EventEmitter.Map = AnyType>(
  value: unknown,
): value is EventEmitter<T> =>
  typeof value === 'object' && value !== null && '_t' in value && value._t === EVENT
