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

  /** Values allowed in a command's `actions`: leaf actions or nested command specs. */
  export type Member = CommandDef.Action<AnyType, AnyType, AnyType> | CommandDef.Spec

  export interface Options<TContext, TError, TArgs extends unknown[]> {
    name: string
    version?: string | undefined
    description?: string | undefined
    actions: Record<string, CommandDef.Member>
    setup?: (...args: TArgs) => Operation<TContext, TError>
  }

  /**
   * What `defineCommand` returns: a pure descriptor of the command tree — NOT a plugin. The registry
   * compiles it into a path-identified plugin tree at `register` (see internal/node) and installs each
   * level lazily as dispatch descends. Nested commands live in `subs` (keyed by the token you type),
   * leaf actions in `leaf`.
   */
  export interface Spec<TContext = unknown, TError = unknown, TArgs extends unknown[] = []> {
    _st: typeof COMMAND
    name: string
    version?: string | undefined
    description?: string | undefined
    leaf: Record<string, CommandDef.Action<AnyType, AnyType, AnyType>>
    subs: Record<string, CommandDef.Spec>
    setup?: ((...args: TArgs) => Operation<TContext, TError>) | undefined
  }

  /**
   * A built command: the plugin compiled from a `Spec` with a tree-path identity (e.g. `kube.config`),
   * so distinct commands never collide in the shared scope even when they share a human `name`.
   */
  export interface Built extends Plugin<AnyType, AnyType, AnyType[], Record<string, AnyType>> {
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
