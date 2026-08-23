import type { TraceDef } from './trace'

/**
 * The ONE wire contract every carrier speaks: envelopes in, envelopes out. Values ride the
 * transport's codec; failures travel as the `Result.Failure` itself (the transport's package
 * plane re-raises them with tag/message/causes intact).
 */
export namespace WireDef {
  /** One plane of a dispatch: which input/output streams exist and under which brand. */
  export interface Plane {
    readonly name: string
    readonly brand: string
  }

  export interface Dispatch {
    readonly k: 'dispatch'
    readonly cid: string
    readonly service: string
    readonly action: string
    readonly args: unknown
    readonly trace: TraceDef.Wire

    /** input streams the caller will pipe (`lane.<cid>.in.<name>`). */
    readonly inputs: readonly Plane[]

    /** absolute deadline (epoch ms) the caller stops waiting at. */
    readonly deadline: number
    readonly idempotencyKey?: string | undefined
    readonly meta?: Readonly<Record<string, string>> | undefined
  }

  export interface Reply {
    readonly k: 'reply'
    readonly cid: string
    readonly value: unknown

    /** output streams the owner pipes (`lane.<cid>.out.<name>`). */
    readonly outputs: readonly Plane[]
  }

  export interface Event {
    readonly k: 'event'
    readonly name: string
    readonly payload: unknown
    readonly origin: string
    readonly trace?: TraceDef.Wire | undefined
  }

  export type Envelope = Dispatch | Reply | Event
}
