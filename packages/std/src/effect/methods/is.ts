import type { AnyType } from 'std:shared'

import { CONTEXT, SCOPE, SNAPSHOT_FLAG } from '../const'
import type { Context, Operation, Scope, Stream, Subscription } from '../types/operation'

export const isOperation = <T>(value: unknown): value is Operation<T> =>
  !!value && typeof (value as Operation<T>)[Symbol.iterator] === 'function'

export const isContext = (value: unknown): value is Context<AnyType> =>
  !!value && typeof value === 'object' && '_t' in value && value._t === CONTEXT

export const isScope = (value: unknown): value is Scope =>
  !!value && typeof value === 'object' && '_t' in value && value._t === SCOPE

export const isSubscription = <T>(value: AnyType): value is Subscription<T, void> =>
  !!value && typeof value === 'object' && typeof value.next === 'function'

export const isStream = isOperation as <T>(value: AnyType) => value is Stream<T, void>

export const isSnapshotContext = (context: Context<unknown>): boolean =>
  (context as Context<unknown> & { [SNAPSHOT_FLAG]?: boolean })[SNAPSHOT_FLAG] === true
