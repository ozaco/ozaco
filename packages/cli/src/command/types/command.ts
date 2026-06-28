import type { Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType, EmptyType, StandardSchemaV1 } from 'std:shared'

import type { ACTION, COMMAND } from '../const'

export namespace CommandDef {
  /** The handler's parsed context type, inferred from the action's `input` schema. */
  export type Infer<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : EmptyType

  export interface ActionConfig<S extends StandardSchemaV1 = StandardSchemaV1> {
    description?: string | undefined
    /** Zod / standard-schema describing the parsed options+args object. */
    input?: S | undefined
    /** Map a schema field to a short flag, e.g. `{ message: 'm' }`. */
    short?: Record<string, string> | undefined
    /** Schema fields fillable positionally, in order. */
    args?: readonly string[] | undefined
  }

  export interface ActionMeta {
    _t: typeof ACTION
    description?: string | undefined
    input?: StandardSchemaV1 | undefined
    short?: Record<string, string> | undefined
    args?: readonly string[] | undefined
  }

  /** A leaf subcommand: a handler carrying its parse metadata (mirrors server's `Action`). */
  export type Action<S = unknown, R = unknown, E = unknown> = CommandDef.ActionMeta &
    ((ctx: CommandDef.Infer<S>) => Operation<R, E>)

  /** Values allowed in a command's `actions`: leaf actions or nested commands. */
  export type Member = CommandDef.Action<AnyType, AnyType, AnyType> | CommandDef.Command

  export interface Options<TContext, TError, TArgs extends unknown[]> {
    name: string
    version?: string | undefined
    description?: string | undefined
    actions: Record<string, CommandDef.Member>
    setup?: (...args: TArgs) => Operation<TContext, TError>
  }

  /** A command is a plugin (install it) with leaf actions; nested subcommands are tracked off-object. */
  export interface Command<
    TContext = unknown,
    TError = unknown,
    TArgs extends unknown[] = [],
  > extends Plugin<TContext, TError, TArgs, Record<string, AnyType>> {
    _st: typeof COMMAND
  }

  /** Resolved option metadata derived from an `input` schema (for tokenizing + help). */
  export interface OptionInfo {
    name: string
    type: 'string' | 'number' | 'boolean'
    array: boolean
    enum?: readonly string[] | undefined
    required: boolean
    hasDefault: boolean
  }
}
