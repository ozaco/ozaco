import type { Flow, Operation } from 'std:effect'
import type { StandardSchemaV1 } from 'std:shared'

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

  export interface Handle<TMap extends Map> {
    /** the declared names, in declaration order. */
    readonly names: readonly Name<TMap>[]

    /** Broadcast to every node. The payload is validated HERE, where a bad one is fixable. */
    emit<TName extends Name<TMap>>(name: TName, payload: Payload<TMap, TName>): Operation<void>

    /** Every occurrence of one event, payload typed and validated. A payload that does not
     * match is dropped and reported (a bad publisher never breaks a subscriber). */
    on<TName extends Name<TMap>>(name: TName): Flow<Received<TMap, TName>, never>
  }
}
