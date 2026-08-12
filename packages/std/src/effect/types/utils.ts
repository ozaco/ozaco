import type { Result } from 'std:result'

import type { Operation, Flow, Subscription } from './operation'

export namespace Utils {
  export interface Exit {
    status: number
    message?: string | undefined
    signal?: string | undefined
    error?: unknown | undefined
  }

  export type Yielded<T extends Operation<unknown>> =
    T extends Operation<infer TYield> ? TYield : never

  export type All<T extends readonly Operation<unknown>[] | []> = {
    -readonly [P in keyof T]: Yielded<T[P]>
  }

  export type AllSettled<T extends readonly Operation<unknown>[] | []> = {
    -readonly [P in keyof T]: Result<Yielded<T[P]>>
  }

  export interface Each {
    <T>(flow: Flow<T, unknown>): Operation<Iterable<T>>
    next(): Operation<void>
  }

  export interface EachLoop<T> {
    subscription: Subscription<T, unknown>
    current: IteratorResult<T>
    finish: () => void
    stale?: true
  }

  export interface HostOperation<T> {
    deno(): Operation<T>
    node(): Operation<T>
    browser(): Operation<T>
  }
}
