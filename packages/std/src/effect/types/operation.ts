import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

import type { CONTEXT, SCOPE } from '../const'

import type { Helpers } from './helpers'

export interface Operation<T> {
  [Symbol.iterator](): Iterator<Helpers.Effect<unknown> | Result.Failure<AnyType>, T, unknown>
}

export type ManualOperation<T> = Generator<
  Helpers.Effect<unknown> | Result.Failure<AnyType>,
  T,
  unknown
>

export interface Future<T> extends Operation<T>, Promise<Result<T, unknown>> {}

export interface Task<T> extends Future<T> {
  halt(): Future<void>

  [Symbol.asyncDispose](): Promise<void>
}

export interface Subscription<T, TDone> {
  next(): Operation<IteratorResult<T, TDone>>
}

export type Stream<T, TReturn> = Operation<Subscription<T, TReturn>>

export interface Signal<T, TClose> extends Stream<T, TClose> {
  send(value: T): void
  close(value: TClose): void
}

export interface Context<T> {
  _t: typeof CONTEXT
  name: string
  defaultValue?: T
  get(): Operation<T | undefined>
  set(value: T): Operation<T>
  expect(): Operation<T>
  delete(): Operation<boolean>
  with<R>(value: T, operation: (value: T) => Operation<R>): Operation<R>
}

export interface Scope {
  _t: typeof SCOPE
  run<T>(operation: () => Operation<T>): Task<T>
  safeRun<T>(operation: () => Operation<T>): Promise<Result<T, unknown>>
  spawn<T>(operation: () => Operation<T>): Operation<Task<T>>
  get<T>(context: Context<T>): T | undefined
  set<T>(context: Context<T>, value: T): T
  expect<T>(context: Context<T>): T
  delete<T>(context: Context<T>): boolean
  hasOwn<T>(context: Context<T>): boolean
}

export interface Channel<T, TClose> extends Stream<T, TClose> {
  send(message: T): Operation<void>
  close(value: TClose): Operation<void>
}

export interface Queue<T, TClose> extends Subscription<T, TClose> {
  add(item: T): void
  close(value: TClose): void
}
