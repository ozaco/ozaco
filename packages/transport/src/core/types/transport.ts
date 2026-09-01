import type { Flow, Operation, Subscription } from 'std:effect'
import type { EventEmitter } from 'std:event'
import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

/** A built transport plugin (`MemoryTransport`, `NatsTransport`, …) — install options are the
 * impl's own, so the argument list stays open. */
export type TransportDef = Plugin<TransportDef.Context, AnyType[], TransportDef.Actions>

/**
 * The `Transport` protocol surface: one topic-addressed messaging contract with five carrying
 * shapes (data, event, flow, stream, package) over any backend. Impls are thin drivers
 * ({@link TransportDef.Driver}); the five planes are built once in core (`transportActions`).
 */
export namespace TransportDef {
  /** A dot-separated subject. Wildcards in subscriptions: `*` = one segment, `>` = the rest. */
  export type Topic = string

  export type Headers = Readonly<Record<string, string>>

  export type Status = 'connected' | 'reconnecting' | 'closed'

  /** What a backend can do beyond plain publish/subscribe. Core fails the matching actions with
   * `transport.unsupported` when a capability is missing. */
  export interface Capabilities {
    /** ack'ed, redelivered subscriptions (`subscribe({ durable })`). */
    readonly durable: boolean
    /** competing consumers (`subscribe({ group })` / `serve({ group })` spread one message over
     * one member). */
    readonly groups: boolean
    /** the backend has native request/reply (otherwise core emulates it over reply topics). */
    readonly requestReply: boolean
    /** the backend reports how many subscribers received a publish (enables instant
     * `no-responders`). */
    readonly receipts: boolean
    /** the largest payload the backend accepts, or null when unbounded. */
    readonly maxPayloadBytes: number | null
  }

  /** The protocol context — what a transport's `setup()` resolves. */
  export interface Options {
    readonly transport: string
    /** the application prefix every topic lives under on the backend. */
    readonly prefix: string
    readonly capabilities: Capabilities
  }

  /** What the install resolves is exactly {@link Options} here. */
  export type Context = Options

  /** The install options every backend shares. */
  export interface CommonOptions {
    /** The APPLICATION prefix: every topic of this install is namespaced under it on the
     * backend (`<prefix>.<topic>`), so several applications share one broker without hearing
     * each other; on NATS it also names the JetStream stream. Dot-separated segments, no
     * wildcards. */
    readonly prefix: string
  }

  /** One delivered message (data/event planes). */
  export interface Message<T = unknown> {
    readonly topic: Topic
    readonly value: T
    readonly headers: Headers
    /** backend sequence/id when the subscription is durable. */
    readonly seq?: string | undefined
    /** acknowledge (durable subscriptions only; a no-op elsewhere). */
    ack(): Operation<void>
    /** negative-acknowledge: ask for redelivery (durable only; a no-op elsewhere). */
    nak(): Operation<void>
  }

  export interface PublishOptions {
    readonly headers?: Headers | undefined
    /** Ephemeral traffic (heartbeats, presence): never stored by a backend that persists
     * deliveries (JetStream keeps it on plain pub/sub) — only subscribers listening right now
     * see it. A backend without persistence treats it like any publish. */
    readonly transient?: boolean | undefined
  }

  export interface SubscribeOptions {
    /** The SUBSCRIPTION prefix: the namespace of this subscriber's `group` / `durable` names
     * (`<prefix>.<name>` on the backend), so two services may both call their durable `main`
     * on the same stream and still be two consumers. */
    readonly prefix?: string | undefined
    /** Competing-consumer group: each message reaches ONE member of the group (at-most-once —
     * what a member took is gone, even if it dies). */
    readonly group?: string | undefined
    /** Durable consumer name: the backend keeps every message from the consumer's creation on
     * until a member `ack()`s it — a message taken and not acked (member died, `nak()`) is
     * redelivered. Members sharing one name share the work. Requires the `durable` capability. */
    readonly durable?: string | undefined
    /** Listen to transient publishes of the topic (see {@link PublishOptions.transient}); no
     * `durable` here. */
    readonly transient?: boolean | undefined
  }

  export interface RequestOptions extends PublishOptions {
    /** Fail with `transport.timeout` when no reply arrived in time. Default 5000. */
    readonly timeoutMs?: number | undefined
  }

  export interface ServeOptions {
    /** The namespace of `group` (see {@link SubscribeOptions.prefix}). */
    readonly prefix?: string | undefined
    /** Load-balance requests over the members of this group. */
    readonly group?: string | undefined
  }

  /** A request handler: args in, value out; a raised failure travels back to the caller with
   * its tag, message and causes intact. */
  export type Handler<TArgs = unknown, TResult = unknown> = (
    args: TArgs,
    message: Message<TArgs>,
  ) => Operation<TResult>

  /** Stop serving / stop a subscription early (both also end with their scope). */
  export type Stop = () => Operation<void>

  export interface LaneOptions {
    /** Frames the producer may have in flight before waiting for consumer credit. Default 32. */
    readonly credit?: number | undefined
    /** How long the producer waits for a consumer to attach before failing `transport.timeout`.
     * Default 5000. */
    readonly timeoutMs?: number | undefined
    /** Bytes one BYTE-lane frame carries at most (`writable`/`readable`): every write is sliced
     * to it, so `credit * frameBytes` bounds what a transfer of any size holds in memory.
     * Default 256 KiB, clamped by the backend's payload limit so stream frames never need the
     * driver's chunk/reassemble path. Value lanes (`pipe`/`flow`) are NOT re-framed — their
     * frames are messages. */
    readonly frameBytes?: number | undefined
  }

  /** The close value of a lane as the consumer sees it: the producer's close value, or the
   * failure the producer's source ended with. */
  export type LaneClose<TClose> = TClose | Result.Failure<unknown>

  /** The five planes + lifecycle. */
  export interface Actions {
    // --- data ---------------------------------------------------------------------------------
    /** Publish one codec-encoded value (a `Uint8Array` goes raw). */
    publish<T>(topic: Topic, value: T, options?: PublishOptions): Operation<void>
    /** A scope-bound subscription; each message decodes to `T` (raw bytes stay `Uint8Array`). */
    subscribe<T = unknown>(topic: Topic, options?: SubscribeOptions): Flow<Message<T>, void>

    // --- event --------------------------------------------------------------------------------
    /** The same subscription as a `std:event` emitter (`{ message: [Message<T>] }`), pumped
     * until the calling scope closes or `stop` is called. */
    events<T = unknown>(
      topic: Topic,
      options?: SubscribeOptions,
    ): Operation<{ emitter: EventEmitter<Events<T>>; stop: Stop }>
    /** `publish` without options — the natural pair of `events`. */
    emit<T>(topic: Topic, value: T): Operation<void>

    // --- flow ---------------------------------------------------------------------------------
    /** Consume a lane as a std Flow: values in producer order, closing with the producer's close
     * value (or its failure). Attach BEFORE the producer starts piping (it waits for credit). */
    flow<T = unknown, TClose = unknown>(
      topic: Topic,
      options?: LaneOptions,
    ): Flow<T, LaneClose<TClose>>
    /** Publish a Flow over a lane with credit-based backpressure; resolves the source's close
     * value once the consumer acknowledged the end. */
    pipe<T, TClose>(topic: Topic, source: Flow<T, TClose>, options?: LaneOptions): Operation<TClose>

    // --- stream -------------------------------------------------------------------------------
    /**
     * A platform `ReadableStream` of the raw byte chunks a peer writes to the lane — the plane
     * for payloads of ANY size (100 MB, 1 GB, 10 GB): frames arrive one pull at a time, so
     * stream backpressure becomes lane credit and nothing is ever materialized whole.
     */
    readable(topic: Topic, options?: LaneOptions): Operation<ReadableStream<Uint8Array>>
    /**
     * A platform `WritableStream`: every chunk travels raw over the lane; `close()` ends it.
     * Writes larger than `frameBytes` are sliced (no copy) into that many frames, so ONE huge
     * write costs no more memory in flight than many small ones — a 10 GB source piped in
     * (`source.pipeTo(writable)`) holds `credit * frameBytes` at a time on either side.
     */
    writable(topic: Topic, options?: LaneOptions): Operation<WritableStream<Uint8Array>>

    // --- package ------------------------------------------------------------------------------
    /** Request/reply carrying a Result: the responder's value, or its failure re-raised with
     * tag/message/causes intact. */
    request<TResult = unknown, TArgs = unknown>(
      topic: Topic,
      args: TArgs,
      options?: RequestOptions,
    ): Operation<TResult>
    /** Answer requests on a topic (scope-bound; `group` balances over members). */
    serve<TArgs = unknown, TResult = unknown>(
      topic: Topic,
      handler: Handler<TArgs, TResult>,
      options?: ServeOptions,
    ): Operation<Stop>

    // --- lifecycle ----------------------------------------------------------------------------
    /** Connection status changes (the current status first). */
    status(): Flow<Status, void>
    /** Flush outstanding publishes and stop consuming; the connection closes with the scope. */
    drain(): Operation<void>
  }

  /** The event map of `events()` emitters. */
  export type Events<T> = {
    message: [message: Message<T>]
  }

  // --- driver ---------------------------------------------------------------------------------

  /** A raw message as the driver delivers it. */
  export interface Raw {
    readonly topic: Topic
    readonly data: Uint8Array
    readonly headers: Headers
    readonly seq?: string | undefined
    readonly ack?: (() => Operation<void>) | undefined
    readonly nak?: (() => Operation<void>) | undefined
  }

  /** What core asks a driver to subscribe with: the consumer names already namespaced by the
   * subscription prefix, plus whether the traffic is transient (request/reply) — a backend that
   * persists deliveries (JetStream) keeps transient traffic on its plain pub/sub. */
  export interface RawSubscribeOptions {
    readonly group?: string | undefined
    readonly durable?: string | undefined
    readonly transient?: boolean | undefined
  }

  /** One publish at the driver boundary: bytes + headers for a topic. `transient` marks
   * request/reply traffic (a backend that persists deliveries keeps it on plain pub/sub);
   * `reply` marks a reply whose topic is the subject the backend itself handed out (absolute —
   * never namespaced). */
  export interface RawPublish {
    readonly topic: Topic
    readonly data: Uint8Array
    readonly headers: Headers
    readonly transient?: boolean | undefined
    readonly reply?: boolean | undefined
  }

  /** One native request as the driver receives it. */
  export interface RawRequest {
    readonly topic: Topic
    readonly data: Uint8Array
    readonly headers: Headers
    readonly timeoutMs: number
  }

  /** What a driver's `subscribe` resolves: a scope-bound raw subscription. */
  export type RawSubscription = Subscription<Raw, void>

  /**
   * The backend contract an impl fulfils; everything else is core. Binary-safe: `data` is bytes,
   * `headers` are always available to core (a backend without native headers frames them into
   * the payload itself).
   */
  export interface Driver {
    readonly capabilities: Capabilities
    /** Publish bytes; resolve the receiver count when the backend knows it (else null). */
    publish(message: RawPublish): Operation<number | null>
    /** Subscribe with wildcards; binds to the calling scope. Delivered `Raw.topic`s are
     * application-relative (the driver strips its prefix). */
    subscribe(topic: Topic, options: RawSubscribeOptions): Operation<RawSubscription>
    /** Native request/reply, when `capabilities.requestReply` (core emulates otherwise). */
    request?(call: RawRequest): Operation<Raw>
    /** The live payload limit when it is only known after connecting (NATS `max_payload`);
     * core chunks publishes above it. Falls back to `capabilities.maxPayloadBytes`. */
    payloadLimit?(): Operation<number | null>
    status(): Flow<Status, void>
    drain(): Operation<void>
  }
}
