import type { StandardSchemaV1 } from 'cli:core'
import type { Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType, EmptyType, Simplify } from 'std:shared'

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

  /** `B` over `A`: `A`'s fields, each shadowed by `B`'s field of the same name. */
  export type Merge<A, B> = Simplify<Omit<A, keyof B> & B>

  /**
   * What an `inherits` field accepts: a command spec (the options it passes down, its declared
   * ancestors' included) or an inherited `input` schema itself. Type-only — ignored at runtime.
   * Across files, prefer the schema (kept in its own module) so the action never imports the
   * command that imports it.
   */
  export type Inherits = Spec<AnyType, AnyType, AnyType, AnyType> | StandardSchemaV1

  /** The `ctx` fields an {@link Inherits} value provides (`EmptyType` for none). */
  export type InheritedOf<P> =
    P extends Spec<AnyType, AnyType, infer I, AnyType>
      ? I
      : P extends StandardSchemaV1
        ? StandardSchemaV1.InferOutput<P>
        : EmptyType

  /**
   * A handler's full `ctx`: the inherited fields `I`, shadowed by the parsed `input` (an action's
   * own field of the same name wins, as at runtime), plus the {@link Runtime} fields.
   */
  export type Ctx<S, I = EmptyType> = Merge<I, Infer<S>> & Runtime

  /**
   * Type-only marker of the inherited fields a member expects from the command it sits under.
   * Contravariant, so placing it under a command that passes down less fails to compile.
   */
  export interface Needs<N> {
    readonly '~needs'?: ((have: N) => void) | undefined
  }

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

  export interface ActionConfig<
    S extends StandardSchemaV1 = StandardSchemaV1,
    P extends Inherits | undefined = undefined,
  > {
    description?: string | undefined
    /**
     * The inherited options this action expects (a command spec or its inherited `input` schema):
     * types them into `ctx` and makes placing the action under a command that does not pass them
     * down a type error. Type-only — ignored at runtime.
     */
    inherits?: P | undefined
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
  export type Action<S = unknown, R = unknown, I = EmptyType> = ActionMeta &
    Needs<I> &
    ((ctx: Ctx<S, I>) => Operation<R>)

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

  /**
   * Values allowed in a command's `actions`: leaf actions or nested command specs, each expecting
   * at most the inherited fields `A` the command passes down.
   */
  export type Member<A = AnyType> =
    | (ActionMeta & Needs<A> & ((ctx: AnyType) => Operation<AnyType>))
    | Spec<unknown, [], AnyType, A>

  /** The fields a command passes down: its `inherits`' fields, shadowed by its own `input`'s. */
  export type Available<P, S> = Merge<InheritedOf<P>, Infer<S>>

  export interface Options<
    TContext,
    TArgs extends unknown[],
    S extends StandardSchemaV1 | undefined = undefined,
    P extends Inherits | undefined = undefined,
  > {
    name: string
    version?: string | undefined
    description?: string | undefined
    actions: Record<string, Member<NoInfer<Available<P, S>>>>
    setup?: (...args: TArgs) => Operation<TContext>
    /** Inherited options schema — see {@link Inherited}. */
    input?: S | undefined
    /**
     * The command's own ancestors (a spec or their inherited `input` schema) when it is nested:
     * their fields join what this command passes down, so its actions can declare
     * `inherits: thisCommand`. Type-only — ignored at runtime.
     */
    inherits?: P | undefined
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
   * type), leaf actions in `leaf`. `I` is what it passes down to its actions (its own inherited
   * `input` over its declared ancestors'), `N` what it expects from the command it sits under —
   * both type-only.
   */
  export interface Spec<
    TContext = unknown,
    TArgs extends unknown[] = [],
    I = AnyType,
    N = AnyType,
  > extends Needs<N> {
    _st: typeof COMMAND
    /** Type-only carrier of the inherited fields (never set at runtime). */
    readonly '~inherited'?: I | undefined
    name: string
    version?: string | undefined
    description?: string | undefined
    leaf: Record<string, Action<AnyType, AnyType, AnyType>>
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
