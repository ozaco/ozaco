import type { StandardSchemaV1 } from 'cli:core'
import type { Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType, EmptyType } from 'std:shared'

import type { ACTION, COMMAND } from '../const'

export namespace CommandDef {
  /** The handler's parsed context type, inferred from the action's `input` schema. */
  export type Infer<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : EmptyType

  /**
   * A manual option declaration — the schema-free way to describe an action's flags. Required for
   * non-zod Standard Schemas (whose shape cannot be introspected without their library) and always
   * wins over schema introspection when present.
   */
  export interface OptionDecl {
    name: string
    /** Value type driving tokenizing + coercion (default `'string'`; booleans take no value). */
    type?: 'string' | 'number' | 'boolean'
    /** The flag may repeat; values collect into an array. */
    array?: boolean
    enum?: readonly string[]
    required?: boolean
  }

  export interface ActionConfig<S extends StandardSchemaV1 = StandardSchemaV1> {
    description?: string | undefined
    /** Zod / standard-schema describing the parsed options+args object. */
    input?: S | undefined
    /** Manual option declarations (see {@link OptionDecl}) — overrides schema introspection. */
    options?: readonly OptionDecl[] | undefined
    /** Map a schema field to a short flag, e.g. `{ message: 'm' }`. */
    short?: Record<string, string> | undefined
    /** Schema fields fillable positionally, in order. */
    args?: readonly string[] | undefined
  }

  export interface ActionMeta {
    _t: typeof ACTION
    description?: string | undefined
    input?: StandardSchemaV1 | undefined
    options?: readonly OptionDecl[] | undefined
    short?: Record<string, string> | undefined
    args?: readonly string[] | undefined
  }

  /** A leaf subcommand: a handler carrying its parse metadata (mirrors server's `Action`). */
  export type Action<S = unknown, R = unknown> = ActionMeta & ((ctx: Infer<S>) => Operation<R>)

  /** Values allowed in a command's `actions`: leaf actions or nested command specs. */
  export type Member = Action<AnyType, AnyType> | Spec

  export interface Options<TContext, TArgs extends unknown[]> {
    name: string
    version?: string | undefined
    description?: string | undefined
    actions: Record<string, Member>
    setup?: (...args: TArgs) => Operation<TContext>
  }

  /**
   * What `defineCommand` returns: a pure descriptor of the command tree — NOT a plugin. The registry
   * compiles it into a path-identified plugin tree at `register` (see internal/node) and installs
   * each level lazily as dispatch descends. Nested commands live in `subs` (keyed by the token you
   * type), leaf actions in `leaf`.
   */
  export interface Spec<TContext = unknown, TArgs extends unknown[] = []> {
    _st: typeof COMMAND
    name: string
    version?: string | undefined
    description?: string | undefined
    leaf: Record<string, Action<AnyType, AnyType>>
    subs: Record<string, Spec>
    setup?: ((...args: TArgs) => Operation<TContext>) | undefined
  }

  /**
   * A built command: the plugin compiled from a `Spec` with a tree-path identity (e.g.
   * `kube.config`), so distinct commands never collide in the shared scope even when they share a
   * human `name`.
   */
  export interface Built extends Plugin<AnyType, AnyType[], Record<string, AnyType>> {
    _st: typeof COMMAND
  }

  /** Resolved option metadata (from a manual declaration or schema introspection). */
  export interface OptionInfo {
    name: string
    type: 'string' | 'number' | 'boolean'
    array: boolean
    enum?: readonly string[] | undefined
    required: boolean
    hasDefault: boolean
  }
}
