import type { StandardSchemaV1 } from 'cli:core'
import type { Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType, EmptyType } from 'std:shared'

import type { ACTION, COMMAND } from '../const'

export namespace CommandDef {
  /** The handler's parsed context type, inferred from the action's `input` schema. */
  export type Infer<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : EmptyType

  /** What the runner adds to every handler's `ctx`, evaluated when the command runs. */
  export interface Runtime {
    /** The tokens after a `--` separator, verbatim (never parsed as flags; empty without one). */
    '--': string[]
    /**
     * The working directory the command runs in — read at dispatch time (not at module load),
     * overridable with `Registry.actions.run(argv, { cwd })`. A parsed `cwd` field wins.
     */
    cwd: string
  }

  /** A handler's full `ctx`: the parsed `input` plus the {@link Runtime} fields. */
  export type Ctx<S> = Infer<S> & Runtime

  /** A usage example rendered under `Examples:` in help. */
  export interface Example {
    /** The command line, shown verbatim (e.g. `app up web api --detach`). */
    run: string
    /** A short note shown next to it. */
    note?: string | undefined
  }

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
    /** Shown in help. */
    description?: string
    /** Shown in help as `(default: …)` — the value itself is applied by the schema, not here. */
    default?: unknown
  }

  export interface ActionConfig<S extends StandardSchemaV1 = StandardSchemaV1> {
    description?: string | undefined
    /** Zod / standard-schema describing the parsed options+args object. */
    input?: S | undefined
    /** Manual option declarations (see {@link OptionDecl}) — overrides schema introspection. */
    options?: readonly OptionDecl[] | undefined
    /** Map a schema field to a short flag, e.g. `{ message: 'm' }`. */
    short?: Record<string, string> | undefined
    /**
     * Schema fields fillable positionally, in order. When the LAST one is an array field it
     * collects every remaining positional (`up web api` → `['web', 'api']`); otherwise surplus
     * positionals fail `cli.parse`.
     */
    args?: readonly string[] | undefined
    /** Usage examples rendered in the action's help. */
    examples?: readonly Example[] | undefined
  }

  export interface ActionMeta {
    _t: typeof ACTION
    description?: string | undefined
    input?: StandardSchemaV1 | undefined
    options?: readonly OptionDecl[] | undefined
    short?: Record<string, string> | undefined
    args?: readonly string[] | undefined
    examples?: readonly Example[] | undefined
  }

  /** A leaf subcommand: a handler carrying its parse metadata (mirrors server's `Action`). */
  export type Action<S = unknown, R = unknown> = ActionMeta & ((ctx: Ctx<S>) => Operation<R>)

  /**
   * Options a command declares for EVERY action below it (its own and its descendants'): the
   * flags are accepted by each of those actions, validated against `input` and merged into their
   * `ctx` (an action's own field of the same name wins). Parse them after the action path
   * (`app deploy --verbose`).
   */
  export interface Inherited {
    input?: StandardSchemaV1 | undefined
    options?: readonly OptionDecl[] | undefined
    short?: Record<string, string> | undefined
  }

  /** Values allowed in a command's `actions`: leaf actions or nested command specs. */
  export type Member = Action<AnyType, AnyType> | Spec

  export interface Options<TContext, TArgs extends unknown[]> {
    name: string
    version?: string | undefined
    description?: string | undefined
    actions: Record<string, Member>
    setup?: (...args: TArgs) => Operation<TContext>
    /** Inherited options schema — see {@link Inherited}. */
    input?: StandardSchemaV1 | undefined
    /** Manual inherited option declarations (non-zod schemas) — see {@link Inherited}. */
    options?: readonly OptionDecl[] | undefined
    /** Short flags for the inherited options, e.g. `{ verbose: 'v' }`. */
    short?: Record<string, string> | undefined
    /** Usage examples rendered in the command's help. */
    examples?: readonly Example[] | undefined
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
    /** The inherited options this level contributes (absent when it declares none). */
    inherit?: Inherited | undefined
    examples?: readonly Example[] | undefined
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
    description?: string | undefined
    /** The default value (only meaningful when `hasDefault`). */
    default?: unknown
  }
}
