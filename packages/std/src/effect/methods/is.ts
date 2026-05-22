import type { AnyType } from 'std:shared'

import { CONTEXT, SCOPE } from '../const'
import type { Context, Operation, Scope, Stream, Subscription } from '../types/operation'

export const isOperation = <T>(value: Operation<T> | Promise<T> | T): value is Operation<T> =>
  value && typeof (value as Operation<T>)[Symbol.iterator] === 'function'

export const isContext = (value: unknown): value is Context<AnyType> =>
  value !== null && typeof value === 'object' && '_t' in value && value._t === CONTEXT

export const isScope = (value: unknown): value is Scope =>
  value !== null && typeof value === 'object' && '_t' in value && value._t === SCOPE

export const isSubscription = <T>(value: AnyType): value is Subscription<T, void> =>
  value !== null && typeof value === 'object' && typeof value.next === 'function'

export const isStream = isOperation as <T>(value: AnyType) => value is Stream<T, void>
