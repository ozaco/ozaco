import type { Database, Schema, Spec } from 'db:core'
import type { ObserveDef } from 'server:core'
import type { TraceDef } from 'std:trace'

/** The shapes this plugin passes around inside itself. */
export namespace Helpers {
  /** rows as plain documents: the handle is untyped on purpose (two tables, one helper). */
  export type Db = Database.Handle<Record<string, Schema.Types<Spec.Doc, Spec.Doc>>>

  /**
   * One message of a batch crossing the carrier to the collector: every record once, each
   * resource once (records point at theirs by index). A batch travels as several of these, each
   * at most 512 KiB serialized.
   */
  export interface Forwarded {
    readonly v: 2
    readonly instance: string
    readonly resources: readonly ObserveDef.Resource[]
    readonly records: readonly ForwardedRecord[]
  }

  /** `[resource index, 't', SpanData | LogData]`. */
  export type ForwardedRecord = readonly [number, ObserveDef.Event['t'], unknown]

  /** One message of a forwarded batch: its payload, the events it carries (a refused message
   * falls back with exactly those) and its serialized (JSON, UTF-8) size. */
  export interface ForwardedChunk {
    readonly payload: Forwarded
    readonly events: readonly ObserveDef.Event[]
    readonly bytes: number
  }

  /** One message being filled: its resources (each once), its records and their events, and the
   * serialized size of the envelope so far. */
  export interface PackingChunk {
    readonly resources: ObserveDef.Resource[]
    readonly index: Map<ObserveDef.Resource, number>
    readonly records: ForwardedRecord[]
    readonly events: ObserveDef.Event[]
    bytes: number
  }

  /** A trace-list position — a root row's `start` and `span_id` (the list's order key), as the
   * page cursor spells it: `<span id>@<start>`. */
  export interface TracePosition {
    readonly start: number
    readonly spanId: string
  }

  /** A resource's attributes as a row keeps them (json): the resource minus the columns. */
  export type ResourceAttributes = Readonly<Record<string, TraceDef.AttrValue>>
}
