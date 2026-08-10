import type { AnyType } from 'std:shared'

import { CONTEXT } from '../const'
import type { Context, Operation } from '../types/operation'

export const isCallTarget = <T>(target: T | Promise<T> | Operation<T>): target is Operation<T> =>
  !!target && typeof (target as Operation<T>)[Symbol.iterator] === 'function'

export const isOperation = <T>(value: unknown): value is Operation<T> =>
  !!value && typeof (value as Operation<T>)[Symbol.iterator] === 'function'

export const isContext = (value: unknown): value is Context<AnyType> =>
  !!value && typeof value === 'object' && '_t' in value && value._t === CONTEXT
