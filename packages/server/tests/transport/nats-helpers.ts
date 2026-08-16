// oxlint-disable import/exports-last
import {
  Broker,
  chunks,
  DataType,
  defineAction,
  defineService,
  DefaultBroker,
  parts,
  stream,
  useSignal,
  useSource,
  useTrace,
  value,
} from 'server:core'
import type { BrokerOptions, Multistream, Service } from 'server:core'
import { box, createQueue, each, run, scoped, sleep } from 'std:effect'
import type { Flow, Operation, Subscription } from 'std:effect'
import { DefaultLogger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { Result } from 'std:result'

import { NatsTransport } from 'server:transport/nats'
import type { NatsTransportOptions } from 'server:transport/nats'
import { BunIO } from 'std:io/impl/bun'

export const natsUrl = process.env.SERVER_TEST_NATS_URL

/** The TLS leg (scripts/test-nats.sh): a `tls://` url + the throwaway CA that signed the server. */
export const natsTlsUrl = process.env.SERVER_TEST_NATS_TLS_URL
export const natsTlsCaFile = process.env.SERVER_TEST_NATS_TLS_CA

/** The nkey leg (scripts/test-nats.sh): an auth-required url + the seed of its only allowed user. */
export const natsNkeyUrl = process.env.SERVER_TEST_NATS_NKEY_URL
export const natsNkeySeed = process.env.SERVER_TEST_NATS_NKEY_SEED

let prefixSeq = 0

/** A unique subject prefix per test so streams/durables never collide on the shared server. */
export const freshPrefix = (): string => {
  prefixSeq += 1

  return `t${Date.now().toString(36)}x${prefixSeq.toString(36)}`
}

/** A re-subscribable flow over fixed values (each subscription replays from the start). */
export const valuesFlow = <T>(values: readonly T[]): Flow<T, unknown> => ({
  *[Symbol.iterator]() {
    let index = 0

    const subscription: Subscription<T, unknown> = {
      *next() {
        if (index < values.length) {
          const item = values[index] as T

          index += 1

          return { done: false, value: item }
        }

        return { done: true, value: true }
      },
    }

    return subscription
  },
})

export const BLOB_CHUNKS: readonly (readonly number[])[] = [
  [0, 255, 128, 10, 13],
  [1, 2, 3],
]

/** The cross-broker fixture service: values, failures, latency, streams and byte lanes. */
export const mathService = (node: string): Service =>
  defineService({
    name: 'math',
    version: '1.0.0',
    actions: {
      add: defineAction(function* (params: { a: number; b: number }) {
        return params.a + params.b
      }),

      whoami: defineAction(function* () {
        return node
      }),

      traceInfo: defineAction(function* () {
        const trace = yield* useTrace()

        return {
          requestId: trace.requestId,
          lane: trace.lane.map(hop => hop.service).join('>'),
        }
      }),

      boom: defineAction({ errors: { 'math.boom': 422 } }, function* () {
        return yield* fail('math.boom', 'the numbers refused')
      }),

      slow: defineAction(function* () {
        yield* sleep(3000)

        return 'late'
      }),

      feed: defineAction({ output: stream() }, function* () {
        return valuesFlow([1, 2, 3])
      }),

      blob: defineAction({ output: chunks() }, function* () {
        return valuesFlow(BLOB_CHUNKS.map(bytes => Uint8Array.from(bytes)))
      }),
    },
  })

/** A local relay service — its handler crosses the wire, extending the trace by one hop. */
export const edgeService: Service = defineService({
  name: 'edge',
  version: '1.0.0',
  actions: {
    relay: defineAction(function* () {
      const trace = yield* useTrace()
      const remote = yield* Broker.actions.call('math', 'traceInfo')

      return { edgeRequestId: trace.requestId, remote }
    }),
  },
})

/** A stateful counter — the idempotency fixture (state lives in the OWNER process). */
export const counterService = (state: { count: number }): Service =>
  defineService({
    name: 'counter',
    version: '1.0.0',
    actions: {
      bump: defineAction(function* () {
        state.count += 1

        return state.count
      }),

      read: defineAction(function* () {
        return state.count
      }),
    },
  })

/** The backpressure fixture's stream shape: `CHUNK_COUNT` chunks of `CHUNK_SIZE` bytes. */
export const CHUNK_SIZE = 8192
export const CHUNK_COUNT = 256

const patternChunk = (index: number): Uint8Array => new Uint8Array(CHUNK_SIZE).fill(index % 256)

/** Streams ~2 MiB of patterned chunks — the LANE backpressure fixture. */
export const firehoseService: Service = defineService({
  name: 'firehose',
  version: '1.0.0',
  actions: {
    blast: defineAction({ output: chunks() }, function* () {
      return valuesFlow(Array.from({ length: CHUNK_COUNT }, (_, index) => patternChunk(index)))
    }),
  },
})

/** Drains a multipart input plane and reports order, fields and byte counts. */
export const uploadService: Service = defineService({
  name: 'upload',
  version: '1.0.0',
  actions: {
    ingest: defineAction({ input: [value(), parts()] }, function* (params) {
      const source = (yield* useSource(DataType.multistream)) as Multistream
      const order: string[] = []
      const fields: Record<string, string> = {}
      const files: { name: string; filename: string; size: number }[] = []

      for (const part of yield* each(source.parts)) {
        if (part.kind === 'field') {
          order.push(`field:${part.name}`)
          fields[part.name] = part.value
        } else {
          order.push(`file:${part.name}`)

          let size = 0

          for (const chunk of yield* each(part.data)) {
            size += chunk.length

            yield* each.next()
          }

          files.push({ name: part.name, filename: part.filename, size })
        }

        yield* each.next()
      }

      return { tag: (params as { tag: string }).tag, order, fields, files }
    }),
  },
})

/** Drains a `stream` input plane and reports the items in arrival order. */
export const streamSumService: Service = defineService({
  name: 'streamsum',
  version: '1.0.0',
  actions: {
    total: defineAction({ input: [value(), stream()] }, function* () {
      const source = (yield* useSource(DataType.stream)) as Flow<number, unknown>
      const seen: number[] = []

      for (const item of yield* each(source)) {
        seen.push(item)

        yield* each.next()
      }

      return { seen, sum: seen.reduce((total, item) => total + item, 0) }
    }),
  },
})

/**
 * The remote-detach fixture: on abandonment the handler keeps working, observes the fired signal
 * and broadcasts what it saw before fulfilling.
 */
export const probeService: Service = defineService({
  name: 'probe',
  version: '1.0.0',
  actions: {
    detachProbe: defineAction({ onDisconnect: 'detach' }, function* () {
      const signal = yield* useSignal()

      yield* sleep(60)
      yield* Broker.actions.broadcast('probe.done', { sawAbort: signal.aborted() })

      return 'done'
    }),
  },
})

interface Job {
  readonly op: () => Operation<unknown>
  readonly settle: (result: Result<unknown>) => void
}

export interface NatsTestNode {
  /** Runs an operation inside the node's scope; throws the Failure object on failure. */
  run<T>(op: () => Operation<T>): Promise<T>
  /** Runs an operation inside the node's scope and returns the raw Result. */
  result<T>(op: () => Operation<T>): Promise<Result<T>>
  /** Winds the node down (transport unregister, consumer stops, connection drain). */
  close(): Promise<void>
}

export interface StartNodeInput {
  readonly prefix: string
  /** Registered BEFORE the transport installs — exercises the registry-scan owner path. */
  readonly register?: readonly Service[] | undefined
  /** Runs after the broker starts but BEFORE the transport installs (pre-wire bus listeners). */
  readonly prepare?: (() => Operation<unknown>) | undefined
  /** Runs AFTER the transport installed — registrations here ride the bus-event owner path. */
  readonly setup?: (() => Operation<unknown>) | undefined
  readonly transport?: Partial<NatsTransportOptions> | undefined
  readonly broker?: BrokerOptions | undefined
}

/**
 * One broker "node" in its own scope (the two-scope pattern): bootstraps IO/logger/broker/NATS
 * inside a long-lived task, then serves test operations through a job queue so every interaction
 * runs with that node's contexts. `close()` ends the scope and waits for the full teardown.
 */
export const startNode = async (input: StartNodeInput): Promise<NatsTestNode> => {
  const jobs = createQueue<Job, undefined>()

  let ready: () => void = () => {}
  let broken: (reason: unknown) => void = () => {}

  const readiness = new Promise<void>((resolve, reject) => {
    ready = resolve
    broken = reject
  })

  const done = run(() =>
    scoped(function* () {
      yield* install(BunIO)
      yield* install(DefaultLogger, { level: LogLevel.silent })
      yield* install(DefaultBroker, input.broker)
      yield* Broker.actions.start()

      for (const service of input.register ?? []) {
        yield* Broker.actions.register(service)
      }

      if (input.prepare) {
        yield* input.prepare()
      }

      yield* install(NatsTransport, {
        servers: natsUrl as string,
        subjectPrefix: input.prefix,
        ...input.transport,
      })

      if (input.setup) {
        yield* input.setup()
      }

      ready()

      while (true) {
        const item = yield* jobs.next()

        if (item.done) {
          return
        }

        const job = item.value

        job.settle(yield* box(job.op))
      }
    }),
  )

  // a failing bootstrap must reject readiness instead of hanging the test
  Promise.resolve(done).then(() => broken(new Error('node closed before it became ready')), broken)

  const result = <T>(op: () => Operation<T>): Promise<Result<T>> =>
    new Promise(resolve => {
      jobs.add({ op: op as () => Operation<unknown>, settle: r => resolve(r as Result<T>) })
    })

  const runOp = async <T>(op: () => Operation<T>): Promise<T> => {
    const outcome = await result(op)

    if (isFailure(outcome)) {
      throw outcome
    }

    return outcome.value
  }

  const close = async (): Promise<void> => {
    jobs.close(undefined)
    await Promise.resolve(done).catch(() => undefined)
  }

  await readiness

  return { result, run: runOp, close }
}
