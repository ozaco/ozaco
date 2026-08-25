import type { AnyType } from 'std:shared'

import { CONTEXT } from '../const'
import type { Context, FutureFlow, Operation } from '../types/operation'

export const isCallTarget = <T>(target: T | Promise<T> | Operation<T>): target is Operation<T> =>
  !!target && typeof (target as Operation<T>)[Symbol.iterator] === 'function'

export const isContext = (value: unknown): value is Context<AnyType> =>
  !!value && typeof value === 'object' && '_t' in value && value._t === CONTEXT

export function isOperation<T>(target: Operation<T> | T): target is Operation<T> {
  return (
    !!target &&
    !isNativeIterable(target) &&
    typeof (target as Operation<T>)[Symbol.iterator] === 'function'
  )
}

export function isNativeIterable(target: unknown): boolean {
  return (
    typeof target === 'string' ||
    Array.isArray(target) ||
    target instanceof Map ||
    target instanceof Set
  )
}

/** A {@link FutureFlow}, structurally: a Flow that also async-iterates and cancels. */
export const isFutureFlow = (value: unknown): value is FutureFlow<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  Symbol.iterator in value &&
  Symbol.asyncIterator in value &&
  'cancel' in value &&
  'done' in value
