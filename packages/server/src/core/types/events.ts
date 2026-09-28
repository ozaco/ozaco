import type { Flow, Operation, Task } from 'std:effect'
import type { StandardSchemaV1 } from 'std:shared'
import type { TraceDef } from 'std:trace'

import type { ServiceDef } from './service'

/** The typed event plane: a name → payload-schema map, and the handle `defineEvents` builds. */
export namespace EventsDef {
  export type Map = Readonly<Record<string, ServiceDef.Schema>>

  export type Name<TMap extends Map> = keyof TMap & string

  /** What an emitter passes (the schema's INPUT side — defaults may be omitted). */
  export type Payload<TMap extends Map, TName extends Name<TMap>> = StandardSchemaV1.InferInput<
    TMap[TName]
  >

  /** What a subscriber receives (the schema's OUTPUT side — defaults applied). */
  export type Received<TMap extends Map, TName extends Name<TMap>> = StandardSchemaV1.InferOutput<
    TMap[TName]
  >

  /** What a handler learns about one occurrence besides its payload. */
  export interface Meta {
    /** the emitting node's service id. */
    readonly origin: string

    /** the emitter's PRODUCER span — the handler's consumer span links it (`creation`) and,
     * outside any span, continues its trace; `null` when the envelope carried none. */
    readonly trace: TraceDef.SpanContext | null
  }

  /** Handles one occurrence; runs inside its consumer span `process {event}` (`current()`). */
  export type Handler<TPayload> = (payload: TPayload, meta: Meta) => Operation<void>

  export interface HandleOptions {
    /** Names this subscription on every consumer span (`messaging.destination.subscription.name`)
     * — tells apart several handlers of one event. */
    readonly subscription?: string | undefined
  }

  export interface Handle<TMap extends Map> {
    /** the declared names, in declaration order. */
    readonly names: readonly Name<TMap>[]

    /** Broadcast to every node. The payload is validated HERE, where a bad one is fixable. */
    emit<TName extends Name<TMap>>(name: TName, payload: Payload<TMap, TName>): Operation<void>

    /** Every occurrence of one event, payload typed and validated — pulled under whatever span
     * is active (it gets an `event.recv` event per item and, for its first 32 items, a
     * `creation` link to the emitter's span; no consumer span of its own). A
     * payload that does not match is dropped and reported (a bad publisher never breaks a
     * subscriber). Ends when the event plane closes. */
    on<TName extends Name<TMap>>(name: TName): Flow<Received<TMap, TName>, never>

    /**
     * Run `handler` for every occurrence of one event, each in its CONSUMER span
     * `process {event}` (`Server.actions.process`): a trace of its own continuing the emitter's
     * (parent = its PRODUCER span), always LINKING it (`creation`) — never parented to the span
     * `handle` was called under. Resolves once SUBSCRIBED (an event emitted after that is
     * handled) with the task running the loop: a child of the calling scope (it ends with it;
     * `halt()` stops it early), done when the event plane closes. One at a time, in arrival
     * order. A payload that does not match (a 400, WARN) or a handler that fails (ERROR for a
     * 5xx) fails THAT event's span — recorded there once (logged through the Logger where
     * tracing is off) — and the loop goes on with the next one.
     */
    handle<TName extends Name<TMap>>(
      name: TName,
      handler: Handler<Received<TMap, TName>>,
      options?: HandleOptions,
    ): Operation<Task<void>>
  }
}
