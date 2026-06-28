import type { Future } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { EmptyType } from 'std:shared'

import type { PaletteDef } from './palette'

export type SpinnerDef = Plugin<
  SpinnerDef.Context,
  unknown,
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
    update(message: string): Future<void, unknown>
    succeed(message?: string): Future<void, unknown>
    fail(message?: string): Future<void, unknown>
    warn(message?: string): Future<void, unknown>
    info(message?: string): Future<void, unknown>
    stop(message?: string): Future<void, unknown>
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
    update(value: number): Future<void, unknown>
    advance(delta?: number): Future<void, unknown>
    succeed(message?: string): Future<void, unknown>
    fail(message?: string): Future<void, unknown>
    stop(message?: string): Future<void, unknown>
  }

  export interface TaskHandle {
    update(message: string): Future<void, unknown>
    succeed(message?: string): Future<void, unknown>
    fail(message?: string): Future<void, unknown>
    warn(message?: string): Future<void, unknown>
    info(message?: string): Future<void, unknown>
    task(message: string): Future<SpinnerDef.TaskHandle, unknown>
    bar(message: string, options?: SpinnerDef.NodeBarOptions): Future<SpinnerDef.BarHandle, unknown>
  }

  export interface GroupOptions {
    frames?: readonly string[]
    interval?: number
  }

  export interface GroupHandle {
    task(message: string): Future<SpinnerDef.TaskHandle, unknown>
    bar(message: string, options?: SpinnerDef.NodeBarOptions): Future<SpinnerDef.BarHandle, unknown>
    stop(): Future<void, unknown>
  }

  export interface Actions {
    start(options?: string | SpinnerDef.StartOptions): Future<SpinnerDef.Handle, unknown>
    bar(options?: string | SpinnerDef.BarOptions): Future<SpinnerDef.BarHandle, unknown>
    group(options?: SpinnerDef.GroupOptions): Future<SpinnerDef.GroupHandle, unknown>
  }
}
