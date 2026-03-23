import type { Result } from 'std:result'

import type { Helpers } from './helpers'
import type { AnyType } from 'std:shared'

export interface Operation<T, E = never> {
  [Symbol.iterator](): Iterator<Helpers.Effect<unknown> | Helpers.FailureOf<E>, T, unknown>
}

export interface Future<T, E = never> extends Operation<T, E>, Promise<Result<T, E>> {}

export interface Task<T, E = never> extends Future<T, E> {
  halt(): Future<void>

  [Symbol.asyncDispose](): Promise<void>
}

export interface Subscription<T, TDone> {
  next(): Operation<IteratorResult<T, TDone>>
}

export type Stream<T, TReturn> = Operation<Subscription<T, TReturn>>

export interface Context<T> {
  name: string
  defaultValue?: T
  get(): Operation<T | undefined>
  set(value: T): Operation<T>
  expect(): Operation<T>
  delete(): Operation<boolean>
  with<R>(value: T, operation: (value: T) => Operation<R>): Operation<R>
}

export interface Scope {
  run<T, E = never>(operation: () => Operation<T, E>): Task<T, E>
  spawn<T, E = never>(operation: () => Operation<T, E>): Operation<Task<T, E>>
  get<T>(context: Context<T>): T | undefined
  set<T>(context: Context<T>, value: T): T
  expect<T>(context: Context<T>): T
  delete<T>(context: Context<T>): boolean
  hasOwn<T>(context: Context<T>): boolean
}

export type Yielded<T extends Operation<unknown, AnyType>> =
  T extends Operation<infer TYield, AnyType> ? TYield : never

export type YieldedError<T extends Operation<unknown, AnyType>> =
  T extends Operation<AnyType, infer TError> ? TError : never
