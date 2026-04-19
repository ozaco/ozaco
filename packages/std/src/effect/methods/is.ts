import type { AnyType } from 'std:shared'

import { CONTEXT, SCOPE } from '../const'
import type { Context, Operation, Scope } from '../types/operation'

export const isOperation = <T>(value: Operation<T> | Promise<T> | T): value is Operation<T> =>
  value && typeof (value as Operation<T>)[Symbol.iterator] === 'function'

export const isContext = (value: unknown): value is Context<AnyType> =>
  typeof value === 'object' && value !== null && '_t' in value && value._t === CONTEXT

export const isScope = (value: unknown): value is Scope =>
  typeof value === 'object' && value !== null && '_t' in value && value._t === SCOPE
