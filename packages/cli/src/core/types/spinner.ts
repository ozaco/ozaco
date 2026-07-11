import type { Future } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { EmptyType } from 'std:shared'

import type { PaletteDef } from './palette'

export type SpinnerDef = Plugin<
  SpinnerDef.Context,
  [options?: SpinnerDef.Options],
  SpinnerDef.Actions
>

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
    update(message: string): Future<void>
    succeed(message?: string): Future<void>
    fail(message?: string): Future<void>
    warn(message?: string): Future<void>
    info(message?: string): Future<void>
    stop(message?: string): Future<void>
  }

  export interface BarOptions {
    message?: string
    total?: number
    width?: number
    frames?: readonly string[]
    interval?: number
  }

  export interface NodeBarOptions {
    total?: number
    width?: number
  }

  export interface BarHandle {
    update(value: number): Future<void>
    advance(delta?: number): Future<void>
    succeed(message?: string): Future<void>
    fail(message?: string): Future<void>
    stop(message?: string): Future<void>
  }

  export interface TaskHandle {
    update(message: string): Future<void>
    succeed(message?: string): Future<void>
    fail(message?: string): Future<void>
    warn(message?: string): Future<void>
    info(message?: string): Future<void>
    task(message: string): Future<SpinnerDef.TaskHandle>
    bar(message: string, options?: SpinnerDef.NodeBarOptions): Future<SpinnerDef.BarHandle>
  }

  export interface GroupOptions {
    frames?: readonly string[]
    interval?: number
  }

  export interface GroupHandle {
    task(message: string): Future<SpinnerDef.TaskHandle>
    bar(message: string, options?: SpinnerDef.NodeBarOptions): Future<SpinnerDef.BarHandle>
    stop(): Future<void>
  }

  export interface Actions {
    start(options?: string | SpinnerDef.StartOptions): Future<SpinnerDef.Handle>
    bar(options?: string | SpinnerDef.BarOptions): Future<SpinnerDef.BarHandle>
    group(options?: SpinnerDef.GroupOptions): Future<SpinnerDef.GroupHandle>
  }
}
