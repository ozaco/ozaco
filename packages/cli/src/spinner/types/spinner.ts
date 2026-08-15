import type { PaletteDef } from 'cli:palette'
import type { Operation } from 'std:effect'
import type { EmptyType } from 'std:shared'

export namespace SpinnerDef {
  export type Options = EmptyType

  export type Context = EmptyType

  export interface StartOptions {
    message?: string
    frames?: readonly string[]
    interval?: number
    color?: PaletteDef.Style
  }

  export interface Handle {
    update(message: string): Operation<void>
    succeed(message?: string): Operation<void>
    fail(message?: string): Operation<void>
    warn(message?: string): Operation<void>
    info(message?: string): Operation<void>
    stop(message?: string): Operation<void>
  }

  export interface BarOptions {
    message?: string
    total?: number
    width?: number
    interval?: number
  }

  export interface NodeBarOptions {
    total?: number
    width?: number
  }

  export interface BarHandle {
    update(value: number): Operation<void>
    advance(delta?: number): Operation<void>
    succeed(message?: string): Operation<void>
    fail(message?: string): Operation<void>
    stop(message?: string): Operation<void>
  }

  export interface TaskHandle {
    update(message: string): Operation<void>
    succeed(message?: string): Operation<void>
    fail(message?: string): Operation<void>
    warn(message?: string): Operation<void>
    info(message?: string): Operation<void>
    task(message: string): Operation<TaskHandle>
    bar(message: string, options?: NodeBarOptions): Operation<BarHandle>
  }

  export interface GroupOptions {
    interval?: number
  }

  export interface GroupHandle {
    task(message: string): Operation<TaskHandle>
    bar(message: string, options?: NodeBarOptions): Operation<BarHandle>
    stop(): Operation<void>
  }

  export interface Actions {
    start(options?: string | StartOptions): Operation<Handle>
    bar(options?: string | BarOptions): Operation<BarHandle>
    group(options?: GroupOptions): Operation<GroupHandle>
  }
}
