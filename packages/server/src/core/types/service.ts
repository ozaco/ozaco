// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import type { ACTION, SERVICE } from '../const'

import type { StreamDef } from './stream'

/**
 * The user-facing definition model: `service(name, { action: action.query({...}, handler) })`.
 * Everything the kernel, the edge, the carriers, the plugins and the docs read about an action
 * is resolved ONCE here into plain data (`ActionDef.meta`) — no runtime sniffing.
 */
export namespace ServiceDef {
  export type Schema = StandardSchemaV1

  /** The function taxonomy (Convex-flavored): drives the default HTTP method, the manifest and
   * the client behaviour. */
  export type Kind = 'query' | 'mutation' | 'action' | 'stream'

  export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

  export interface Route {
    readonly method: HttpMethod
    readonly path: string
  }

  /** What `input` / `output` accept: a bare schema (the value plane), a branded stream, a
   * multipart declaration, or nothing. */
  export type Declaration = Schema | StreamDef.Decl | StreamDef.PartsDecl

  /** What happens to a running handler when the caller disconnects or abandons the call. */
  export type DisconnectMode = 'cancel' | 'detach'

  /**
   * An action's configuration. Plugins extend it with their own top-level keys (`cache`,
   * `timeoutMs`, `auth`, …) — typed through their `options()` helpers, validated at
   * `createServer` time against the schemas the plugins declare. Unknown keys are a
   * configuration failure: an option nobody handles is a typo, not a feature.
   */
  export interface Config<
    TInput extends Declaration | undefined = Declaration | undefined,
    TOutput extends Declaration | undefined = Declaration | undefined,
  > {
    readonly title?: string | undefined
    readonly description?: string | undefined
    readonly input?: TInput
    readonly output?: TOutput
    readonly route?: Route | undefined
    readonly onDisconnect?: DisconnectMode | undefined

    /** Always persist this action's outcome (otherwise only undeliverable replies are). */
    readonly outcome?: boolean | undefined

    /** Failure tag → HTTP status overrides; also feeds the docs error catalog. */
    readonly errors?: Readonly<Record<string, number>> | undefined
    readonly tags?: readonly string[] | undefined

    /** plugin options — see the plugin's `options()` helper for the typed shape. */
    readonly [option: string]: unknown
  }

  /** The handler's `params` type: the value plane of the input. */
  export type Params<D> = D extends undefined
    ? undefined
    : D extends StandardSchemaV1
      ? StandardSchemaV1.InferOutput<D>
      : D extends StreamDef.Decl<string, infer T>
        ? StreamDef.Branded<string, T>
        : D extends StreamDef.PartsDecl<infer TFields, infer TStreams>
          ? StreamDef.Parts<TFields, TStreams>
          : unknown

  /** The handler's return type: the value plane of the output, or a branded stream. */
  export type Returns<D> = D extends undefined
    ? void
    : D extends StandardSchemaV1
      ? StandardSchemaV1.InferOutput<D>
      : D extends StreamDef.Decl<infer B, infer T>
        ? StreamDef.Branded<B, AnyType> | StreamDef.Source<T>
        : unknown

  /** Everything resolved about an action: what the kernel/edge/carriers/plugins/docs read. */
  export interface Meta {
    readonly kind: Kind
    readonly title: string | undefined
    readonly description: string | undefined
    readonly input: Declaration | null
    readonly output: Declaration | null

    /** value | stream | parts — derived from the declarations. */
    readonly inputPlane: 'none' | 'value' | 'stream' | 'parts'
    readonly outputPlane: 'none' | 'value' | 'stream'
    readonly route: Route
    readonly onDisconnect: DisconnectMode
    readonly outcome: boolean
    readonly errors: Readonly<Record<string, number>>
    readonly tags: readonly string[]

    /** plugin options as given (validated at createServer). */
    readonly options: Readonly<Record<string, unknown>>
  }

  /** The handler signature: ONE argument. */
  export type Handler<TParams, TResult, TCtx> = (call: {
    readonly input: TParams
    readonly ctx: TCtx
  }) => Operation<TResult>

  export interface Action<
    TInput extends Declaration | undefined = Declaration | undefined,
    TOutput extends Declaration | undefined = Declaration | undefined,
  > {
    readonly _t: typeof ACTION
    readonly meta: Meta
    readonly handler: Handler<Params<TInput>, Returns<TOutput>, AnyType>
    readonly [INPUT]?: TInput
    readonly [OUTPUT]?: TOutput
  }

  export type ActionMap = Record<string, Action<AnyType, AnyType>>

  export interface Service<TName extends string = string, TActions extends ActionMap = ActionMap> {
    readonly _t: typeof SERVICE
    readonly name: TName
    readonly version: string
    readonly description: string | undefined
    readonly actions: TActions
  }

  export interface ServiceOptions {
    readonly version?: string | undefined
    readonly description?: string | undefined
  }

  // --- typed references (what `ctx.call` / the client take) ----------------------------------

  export type ActionKey<S extends Service> = keyof S['actions'] & string

  export type InputOf<A> = A extends Action<infer I, AnyType> ? Params<I> : never
  export type OutputOf<A> = A extends Action<AnyType, infer O> ? Returns<O> : never

  /** A typed pointer to one action of one service: `api.todos.list`. */
  export interface Ref<A extends Action = Action> {
    readonly service: string
    readonly action: string
    readonly [ACTION_REF]?: A
  }

  export type Api<TServices extends readonly Service[]> = {
    readonly [S in TServices[number] as S['name']]: {
      readonly [K in keyof S['actions']]: Ref<S['actions'][K]>
    }
  }
}

declare const INPUT: unique symbol
declare const OUTPUT: unique symbol
declare const ACTION_REF: unique symbol
