import type { Result } from 'std:result'

import type { CONTEXT, SCOPE } from '../const'

import type { Helpers } from './helpers'

export interface Operation<T, E = never> {
  [Symbol.iterator](): Iterator<Helpers.Effect<unknown> | Helpers.FailureOf<E>, T, unknown>
}

export type ManualOperation<T, E = never> = Generator<
  Helpers.Effect<unknown> | Helpers.FailureOf<E>,
  T,
  unknown
>

export interface Future<T, E = never> extends Operation<T, E>, Promise<Result<T, E>> {}

export interface Task<T, E = never> extends Future<T, E> {
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
  with<R, E>(value: T, operation: (value: T) => Operation<R, E>): Operation<R, E>
}

export interface Scope {
  _t: typeof SCOPE
  run<T, E = never>(operation: () => Operation<T, E>): Task<T, E>
  safeRun<T, E = never>(operation: () => Operation<T, E>): Promise<Result<T, E>>
  spawn<T, E = never>(operation: () => Operation<T, E>): Operation<Task<T, E>>
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
