import {
  Broker,
  CoreErrors,
  createMultistreamAssembler,
  DataType,
  decodeEnvelope,
  encodeEnvelope,
  inputLaneOf,
} from 'server:core'
import type { Reply, Trace, Wire } from 'server:core'
import { collectFlow } from 'server:utils'
import { scoped, sleep } from 'std:effect'
import { install } from 'std:plugin'
import { fail, isFailure, isJust, nothing } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { JetStreamApiError } from '@nats-io/jetstream'
import { nkeyAuthenticator } from '@nats-io/nats-core'
import { natsImpl, NatsErrors, NatsTransport } from 'server:transport/nats'
import type { ConnectionOptions, NatsConnection, NatsTransportOptions } from 'server:transport/nats'
import { JsonCodec } from 'std:codec/impl/json'

import { encodeLaneFrame, parseLaneFrame } from '../../src/transport/nats/internal/frames'
import { isStreamFull, OUTPUT_LANE } from '../../src/transport/nats/internal/lanes'
import { provisionStreams } from '../../src/transport/nats/internal/provision'
import type { ProvisionInput } from '../../src/transport/nats/internal/provision'
import { createStreamNames, createSubjects } from '../../src/transport/nats/internal/subjects'
import { bootstrap, cidOf } from '../core/helpers'
import { runResult, runScoped } from '../helpers'

import {
  BLOB_CHUNKS,
  CHUNK_COUNT,
  CHUNK_SIZE,
  counterService,
  edgeService,
  firehoseService,
  freshPrefix,
  mathService,
  natsNkeySeed,
  natsNkeyUrl,
  natsTlsCaFile,
  natsTlsUrl,
  natsUrl,
  probeService,
  startNode,
  streamSumService,
  uploadService,
  valuesFlow,
} from './nats-helpers'

const sampleTrace: Trace = {
  requestId: 'r_test',
  origin: 'internal',
  serviceId: 'math@1#abc',
  actionId: 'a_1',
  lane: [{ service: 'math', action: 'add', actionId: 'a_1', transport: 'internal', ts: 1 }],
}

const wait = (ms: number) =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

describe('nats lane framing', () => {
  it('byte data frames survive exactly (raw payload, never the JSON codec)', () => {
    const data = Uint8Array.from([0, 255, 128, 10, 13])
    const encoded = encodeLaneFrame({ kind: 'data', seq: 3, data })
    const parsed = parseLaneFrame({ data: encoded.payload, headers: encoded.headers })

    expect(parsed).toBeDefined()
    expect(parsed?.kind).toBe('data')
    expect(parsed?.seq).toBe(3)

    if (parsed?.kind === 'data') {
      expect(parsed.data).toBeInstanceOf(Uint8Array)
      expect([...parsed.data]).toEqual([0, 255, 128, 10, 13])
    }
  })

  it('end frames round trip', () => {
    const encoded = encodeLaneFrame({ kind: 'end', seq: 7 })
    const parsed = parseLaneFrame({ data: encoded.payload, headers: encoded.headers })

    expect(parsed).toEqual({ kind: 'end', seq: 7 })
  })

  it('error frames carry the Wire.Failure with full fidelity', () => {
    const failure: Wire.Failure = {
      error: 'math.boom',
      message: 'the numbers refused',
      causes: ['action:boom(a_1) svc:math@1#abc req:r_1 lane:math'],
      status: 422,
    }
    const encoded = encodeLaneFrame({ kind: 'error', seq: 4, failure })
    const parsed = parseLaneFrame({ data: encoded.payload, headers: encoded.headers })

    expect(parsed?.kind).toBe('error')

    if (parsed?.kind === 'error') {
      expect(parsed.failure.error).toBe('math.boom')
      expect(parsed.failure.message).toBe('the numbers refused')
      expect(parsed.failure.causes).toEqual([...failure.causes])
      expect(parsed.failure.status).toBe(422)
    }
  })

  it('unframed messages are rejected instead of guessed at', () => {
    expect(parseLaneFrame({ data: Uint8Array.from([1, 2, 3]) })).toBeUndefined()
  })

  it('chunk frames (raw multipart file bytes) round trip untouched', () => {
    const data = Uint8Array.from([7, 0, 255, 1])
    const encoded = encodeLaneFrame({ kind: 'chunk', seq: 9, data })
    const parsed = parseLaneFrame({ data: encoded.payload, headers: encoded.headers })

    expect(parsed?.kind).toBe('chunk')
    expect(parsed?.seq).toBe(9)

    if (parsed?.kind === 'chunk') {
      expect([...parsed.data]).toEqual([7, 0, 255, 1])
    }
  })
})

describe('nats lane naming', () => {
  it('input planes ride in_<DataType> lane tokens, the reply stays lane 0', () => {
    const subjects = createSubjects('acme')

    expect(subjects.lane('c1', OUTPUT_LANE)).toBe('acme.v1.lane.c1.0')
    expect(subjects.lane('c1', inputLaneOf(DataType.multistream))).toBe(
      'acme.v1.lane.c1.in_multistream',
    )
    expect(subjects.lane('c1', inputLaneOf(DataType.stream))).toBe('acme.v1.lane.c1.in_stream')
  })
})

describe('nats full-stream detection', () => {
  it('matches the probed discard:new workqueue rejections and nothing else', () => {
    const full = new JetStreamApiError({
      code: 503,
      err_code: 10_077,
      description: 'maximum bytes exceeded',
    })
    const msgs = new JetStreamApiError({
      code: 503,
      err_code: 10_076,
      description: 'maximum messages exceeded',
    })
    const missing = new JetStreamApiError({
      code: 404,
      err_code: 10_014,
      description: 'consumer not found',
    })

    expect(isStreamFull(full)).toBe(true)
    expect(isStreamFull(msgs)).toBe(true)
    expect(isStreamFull(missing)).toBe(false)
    expect(isStreamFull(new Error('maximum bytes exceeded'))).toBe(false)
  })
})

describe('nats provisioning', () => {
  const jetstreamOptions = {
    replicas: 1,
    rpcMaxAgeMs: 60_000,
    laneMaxAgeMs: 300_000,
    laneMaxBytes: 262_144,
    laneFullTimeoutMs: 30_000,
    outcomeTtlMs: 600_000,
    storage: 'memory',
  } as const

  const provision = async (durable: boolean) => {
    const added: Record<string, unknown>[] = []
    const jsm = {
      streams: {
        add: (spec: Record<string, unknown>) => {
          added.push(spec)

          return Promise.resolve({})
        },
        update: () => Promise.reject(new Error('first boot must not need an update')),
      },
    } as unknown as ProvisionInput['jsm']

    await runScoped(function* () {
      yield* provisionStreams({
        jsm,
        streams: createStreamNames('acme'),
        subjects: createSubjects('acme'),
        options: jetstreamOptions,
        events: { durable, maxAgeMs: 86_400_000, storage: 'file' },
      })
    })

    return added
  }

  it('the LANE stream is a bounded workqueue: discard new + max_bytes backpressure', async () => {
    const added = await provision(false)

    expect(added.map(spec => spec.name)).toEqual(['ACME_RPC', 'ACME_LANE', 'ACME_OUTCOME'])

    const lane = added[1] as Record<string, unknown>

    expect(lane.retention).toBe('workqueue')
    expect(lane.discard).toBe('new')
    expect(lane.max_bytes).toBe(262_144)
    expect(lane.max_age).toBe(300_000 * 1_000_000)
    expect(lane.subjects).toEqual(['acme.v1.lane.>'])
  })

  it('the EVENT stream exists only with durable events, as a TTLd limits stream', async () => {
    const added = await provision(true)

    expect(added.map(spec => spec.name)).toEqual([
      'ACME_RPC',
      'ACME_LANE',
      'ACME_OUTCOME',
      'ACME_EVENT',
    ])

    const event = added[3] as Record<string, unknown>

    expect(event.retention).toBe('limits')
    expect(event.storage).toBe('file')
    expect(event.max_age).toBe(86_400_000 * 1_000_000)
    expect(event.subjects).toEqual(['acme.v1.event.>'])
  })
})

describe('nats wire envelopes', () => {
  it('every structured envelope kind round-trips through the routed codec', async () => {
    const envelopes: Wire.Envelope[] = [
      { k: 'ack', cid: 'c_1' },
      { k: 'cancel', cid: 'c_1' },
      { k: 'abandoned', cid: 'c_1' },
      {
        k: 'dispatch',
        v: 1,
        cid: 'c_1',
        service: 'upload',
        action: 'ingest',
        trace: sampleTrace,
        params: { tag: 'x' },
        lanes: { streams: 1, parts: true },
      },
      {
        k: 'outcome',
        cid: 'c_1',
        outcome: { cid: 'c_1', state: 'cancelled', ts: 12, serviceId: 's@1#i', actionId: 'a_1' },
      },
      { k: 'reply', cid: 'c_1', value: { x: 1 }, status: 201, meta: { 'x-a': '1' } },
      {
        k: 'reply-failure',
        cid: 'c_1',
        failure: { error: 'math.boom', message: 'nope', causes: ['crumb'], status: 422 },
      },
      { k: 'reply-stream', cid: 'c_1', bytes: true, status: 200 },
      {
        k: 'event',
        name: 'cache.reset',
        payload: { table: 'users' },
        trace: sampleTrace,
        scope: 'broadcast',
        origin: 'i_abc',
      },
    ]

    const decoded = await runScoped(function* () {
      yield* install(JsonCodec)

      const results: Wire.Envelope[] = []

      for (const envelope of envelopes) {
        results.push(yield* decodeEnvelope(yield* encodeEnvelope(envelope)))
      }

      return results
    })

    expect(decoded).toEqual(envelopes)
  })

  it('lane envelopes with bytes DO get mangled by JSON — the reason lanes are framed natively', async () => {
    const lane: Wire.Envelope = {
      k: 'lane',
      cid: 'c_1',
      lane: '0',
      seq: 1,
      data: Uint8Array.from([1, 2, 3]),
    }

    const decoded = await runScoped(function* () {
      yield* install(JsonCodec)

      return yield* decodeEnvelope(yield* encodeEnvelope(lane))
    })

    expect(decoded.k).toBe('lane')

    if (decoded.k === 'lane') {
      // JSON.stringify turns a Uint8Array into a plain index object — bytes never survive the
      // codec, so the carrier moves them as raw NATS payloads with a header frame instead.
      expect(decoded.data).not.toBeInstanceOf(Uint8Array)
    }
  })
})

describe('nats transport options', () => {
  const fakeConnection = (): NatsConnection =>
    ({
      options: {},
      request: () => Promise.reject(new Error('this fake speaks no jetstream')),
      publish: () => {},
      drain: () => Promise.resolve(),
      close: () => Promise.resolve(),
      isClosed: () => true,
      isDraining: () => false,
      getServer: () => 'fake:4222',
      closed: () => Promise.resolve(),
      flush: () => Promise.resolve(),
      rtt: () => Promise.resolve(0),
      stats: () => ({ inBytes: 0, outBytes: 0, inMsgs: 0, outMsgs: 0 }),
      status: () => (async function* () {})(),
    }) as unknown as NatsConnection

  it('passes the FULL ConnectionOptions through to connect verbatim (servers sugar included)', async () => {
    let captured: ConnectionOptions | undefined

    const connection: ConnectionOptions = {
      name: 'client-x',
      user: 'alice',
      pass: 'secret',
      token: 'tok',
      tls: { handshakeFirst: true, ca: 'PEM' },
      reconnect: false,
      maxReconnectAttempts: 7,
      reconnectTimeWait: 123,
      reconnectJitter: 45,
      pingInterval: 10_000,
      maxPingOut: 3,
      noEcho: true,
      noRandomize: true,
      inboxPrefix: '_CUSTOM',
      waitOnFirstConnect: true,
      ignoreClusterUpdates: true,
    }

    const outcome = await runResult(function* () {
      yield* bootstrap()
      yield* natsImpl.set({
        connect: options => {
          captured = options

          return Promise.resolve(fakeConnection())
        },
      })

      yield* install(NatsTransport, { servers: 'nats://example.com:4222', connection })
    })

    // the fake has no JetStream — setup must fail CLEANLY with the jetstream tag
    expect(isFailure(outcome)).toBe(true)

    if (isFailure(outcome)) {
      expect(outcome.error).toBe(NatsErrors.Jetstream)
    }

    expect(captured).toBeDefined()
    expect(captured?.servers).toBe('nats://example.com:4222')
    expect(captured?.name).toBe('client-x')
    expect(captured?.user).toBe('alice')
    expect(captured?.pass).toBe('secret')
    expect(captured?.token).toBe('tok')
    expect(captured?.tls).toEqual({ handshakeFirst: true, ca: 'PEM' })
    expect(captured?.reconnect).toBe(false)
    expect(captured?.maxReconnectAttempts).toBe(7)
    expect(captured?.reconnectTimeWait).toBe(123)
    expect(captured?.reconnectJitter).toBe(45)
    expect(captured?.pingInterval).toBe(10_000)
    expect(captured?.maxPingOut).toBe(3)
    expect(captured?.noEcho).toBe(true)
    expect(captured?.noRandomize).toBe(true)
    expect(captured?.inboxPrefix).toBe('_CUSTOM')
    expect(captured?.waitOnFirstConnect).toBe(true)
    expect(captured?.ignoreClusterUpdates).toBe(true)
  })

  it('installing without a broker fails with a configuration error', async () => {
    const outcome = await runResult(function* () {
      yield* install(NatsTransport, {})
    })

    expect(isFailure(outcome)).toBe(true)

    if (isFailure(outcome)) {
      expect(outcome.error).toBe(NatsErrors.Configuration)
    }
  })
})

describe.skipIf(!natsUrl)('nats transport (docker-gated)', () => {
  it('cross-broker dispatch: value comes home, requestId survives, lane records both hops', async () => {
    const prefix = freshPrefix()
    const a = await startNode({ prefix, register: [mathService('A')] })
    const b = await startNode({ prefix, setup: () => Broker.actions.register(edgeService) })

    try {
      const sum = await b.run(() => Broker.actions.call('math', 'add', { a: 2, b: 3 }))

      expect(sum).toBe(5)

      const relayed = (await b.run(() => Broker.actions.call('edge', 'relay'))) as {
        edgeRequestId: string
        remote: { requestId: string; lane: string }
      }

      expect(relayed.remote.requestId).toBe(relayed.edgeRequestId)
      expect(relayed.remote.lane).toBe('edge>math')
    } finally {
      await b.close()
      await a.close()
    }
  }, 15_000)

  it('failure fidelity: tag, message, breadcrumbs and status survive the wire', async () => {
    const prefix = freshPrefix()
    const a = await startNode({ prefix, register: [mathService('A')] })
    const b = await startNode({ prefix })

    try {
      const failure = await b.result(() => Broker.actions.call('math', 'boom'))

      expect(isFailure(failure)).toBe(true)

      if (isFailure(failure)) {
        expect(failure.error).toBe('math.boom')
        expect(failure.message).toBe('the numbers refused')
        expect(failure.causes.some(cause => String(cause).includes('action:boom'))).toBe(true)
        expect(failure.causes.some(cause => String(cause).includes('call:math.boom'))).toBe(true)
      }

      const reply = (await b.run(() => Broker.actions.exchange('math', 'boom'))) as Reply

      expect(reply.kind).toBe('failure')

      if (reply.kind === 'failure') {
        expect(reply.status).toBe(422)
        expect(reply.failure.error).toBe('math.boom')
      }
    } finally {
      await b.close()
      await a.close()
    }
  }, 15_000)

  it('queue balancing: two owners of one service share the durable', async () => {
    const prefix = freshPrefix()
    const a = await startNode({ prefix, register: [mathService('A')] })
    const a2 = await startNode({ prefix, register: [mathService('A2')] })
    const b = await startNode({ prefix })

    try {
      const served = await b.run(function* () {
        const nodes = new Set<string>()

        for (let call = 0; call < 12; call += 1) {
          nodes.add((yield* Broker.actions.call('math', 'whoami')) as string)
        }

        return [...nodes]
      })

      expect(served.length).toBeGreaterThanOrEqual(2)
    } finally {
      await b.close()
      await a2.close()
      await a.close()
    }
  }, 20_000)

  it('fulfillment: a dead owner leaves the dispatch unacked → TimeoutUnreached', async () => {
    const prefix = freshPrefix()
    const a = await startNode({ prefix, register: [mathService('A')] })

    // the durable consumer survives the owner — hosts() stays positive, nobody acks
    await a.close()

    const b = await startNode({ prefix })

    try {
      const failure = await b.result(() =>
        Broker.actions.call('math', 'add', { a: 1, b: 1 }, { ackTimeoutMs: 300 }),
      )

      expect(isFailure(failure)).toBe(true)

      if (isFailure(failure)) {
        expect(failure.error).toBe(CoreErrors.TimeoutUnreached)
      }
    } finally {
      await b.close()
    }
  }, 15_000)

  it('fulfillment: ack without reply → TimeoutPending, cancel reaches the owner, outcome says cancelled', async () => {
    const prefix = freshPrefix()
    const a = await startNode({ prefix, register: [mathService('A')] })
    const b = await startNode({ prefix })

    try {
      const failure = await b.result(() =>
        Broker.actions.call('math', 'slow', undefined, { ackTimeoutMs: 2000, timeoutMs: 250 }),
      )

      expect(isFailure(failure)).toBe(true)

      if (!isFailure(failure)) {
        return
      }

      expect(failure.error).toBe(CoreErrors.TimeoutPending)

      const cid = cidOf(failure)

      // the owner publishes the outcome right after the cancel lands — poll briefly
      const stored = await b.run(function* () {
        for (let poll = 0; poll < 25; poll += 1) {
          const outcome = yield* NatsTransport.actions.outcome(cid)

          if (isJust(outcome)) {
            return outcome
          }

          yield* sleep(200)
        }

        return nothing<never>()
      })

      expect(isJust(stored)).toBe(true)

      if (isJust(stored)) {
        const record = stored.value as { state: string; cid: string }

        expect(record.state).toBe('cancelled')
        expect(record.cid).toBe(cid)
      }
    } finally {
      await b.close()
      await a.close()
    }
  }, 20_000)

  it('idempotency: the same key from two different callers executes exactly once', async () => {
    const prefix = freshPrefix()
    const state = { count: 0 }
    const a = await startNode({ prefix, register: [counterService(state)] })
    const b = await startNode({ prefix })
    const c = await startNode({ prefix })

    try {
      const first = await b.run(() =>
        Broker.actions.call('counter', 'bump', undefined, { idempotencyKey: 'op-1' }),
      )

      expect(first).toBe(1)

      // a DIFFERENT caller broker retries the same key — the caller-local reply cache cannot
      // help here; the JetStream duplicate window is the guard
      const retried = await c.result(() =>
        Broker.actions.call('counter', 'bump', undefined, { idempotencyKey: 'op-1' }),
      )

      expect(isFailure(retried)).toBe(true)

      if (isFailure(retried)) {
        expect(retried.error).toBe(CoreErrors.Conflict)
      }

      expect(await b.run(() => Broker.actions.call('counter', 'read'))).toBe(1)
      expect(state.count).toBe(1)
    } finally {
      await c.close()
      await b.close()
      await a.close()
    }
  }, 15_000)

  it('streams: value lanes arrive in order and byte lanes stay raw', async () => {
    const prefix = freshPrefix()
    const a = await startNode({ prefix, register: [mathService('A')] })
    const b = await startNode({ prefix })

    try {
      const values = await b.run(function* () {
        const reply: Reply = yield* Broker.actions.exchange('math', 'feed')

        if (reply.kind !== 'stream') {
          return yield* fail('test.expected-stream', `got a ${reply.kind} reply`)
        }

        return yield* collectFlow(reply.flow)
      })

      expect(values).toEqual([1, 2, 3])

      const blobs = (await b.run(function* () {
        const reply: Reply = yield* Broker.actions.exchange('math', 'blob')

        if (reply.kind !== 'stream') {
          return yield* fail('test.expected-stream', `got a ${reply.kind} reply`)
        }

        expect(reply.bytes).toBe(true)

        return yield* collectFlow(reply.flow)
      })) as readonly Uint8Array[]

      expect(blobs).toHaveLength(BLOB_CHUNKS.length)

      for (const [index, chunk] of blobs.entries()) {
        expect(chunk).toBeInstanceOf(Uint8Array)
        expect([...chunk]).toEqual([...(BLOB_CHUNKS[index] as readonly number[])])
      }
    } finally {
      await b.close()
      await a.close()
    }
  }, 15_000)

  it('events: a broadcast reaches the other node exactly once, echoes suppressed', async () => {
    const prefix = freshPrefix()
    const a = await startNode({ prefix })
    const b = await startNode({ prefix })

    try {
      const seenOnA: unknown[] = []
      const seenOnB: unknown[] = []

      await a.run(() =>
        Broker.actions.on('cache.reset', payload => {
          seenOnA.push(payload)
        }),
      )
      await b.run(() =>
        Broker.actions.on('cache.reset', payload => {
          seenOnB.push(payload)
        }),
      )

      await a.run(() => Broker.actions.broadcast('cache.reset', { table: 'users' }))
      await wait(500)

      // B hears it exactly once (over nats); A hears its LOCAL emission once — the nats echo
      // is dropped by origin nodeId
      expect(seenOnB).toEqual([{ table: 'users' }])
      expect(seenOnA).toEqual([{ table: 'users' }])
    } finally {
      await b.close()
      await a.close()
    }
  }, 15_000)

  it('teardown: a node with live consumers drains without hanging', async () => {
    const prefix = freshPrefix()
    const node = await startNode({ prefix, register: [mathService('solo')] })

    await node.close()

    expect(true).toBe(true)
  }, 15_000)

  it('input lanes: a multistream crosses the broker with order, fields and bytes intact', async () => {
    const prefix = freshPrefix()
    const a = await startNode({ prefix, register: [uploadService] })
    const b = await startNode({ prefix })

    try {
      const frames: Wire.PartFrame[] = [
        { p: 'field', name: 'meta', value: 'v1' },
        { p: 'file', name: 'doc', filename: 'doc.bin', contentType: 'application/octet-stream' },
        { p: 'chunk', data: Uint8Array.from([0, 255, 128, 10, 13]) },
        { p: 'chunk', data: Uint8Array.from([1, 2, 3]) },
        { p: 'file-end' },
        { p: 'file', name: 'img', filename: 'img.png', contentType: 'image/png' },
        { p: 'chunk', data: new Uint8Array(1000).fill(9) },
        { p: 'file-end' },
      ]

      const result = await b.run(function* () {
        const assembler = createMultistreamAssembler()

        for (const frame of frames) {
          assembler.push(frame)
        }

        assembler.end()

        return yield* Broker.actions.call(
          'upload',
          'ingest',
          { tag: 'x' },
          { sources: new Map<string, unknown>([[DataType.multistream, assembler.multistream]]) },
        )
      })

      expect(result).toEqual({
        tag: 'x',
        order: ['field:meta', 'file:doc', 'file:img'],
        fields: { meta: 'v1' },
        files: [
          { name: 'doc', filename: 'doc.bin', size: 8 },
          { name: 'img', filename: 'img.png', size: 1000 },
        ],
      })
    } finally {
      await b.close()
      await a.close()
    }
  }, 15_000)

  it('input lanes: a stream plane feeds the remote handler in order', async () => {
    const prefix = freshPrefix()
    const a = await startNode({ prefix, register: [streamSumService] })
    const b = await startNode({ prefix })

    try {
      const result = await b.run(() =>
        Broker.actions.call('streamsum', 'total', undefined, {
          sources: new Map<string, unknown>([[DataType.stream, valuesFlow([1, 2, 3, 4])]]),
        }),
      )

      expect(result).toEqual({ seen: [1, 2, 3, 4], sum: 10 })
    } finally {
      await b.close()
      await a.close()
    }
  }, 15_000)

  it('backpressure: a slow consumer parks the producer, every byte still arrives', async () => {
    const prefix = freshPrefix()
    const jetstream = { laneMaxBytes: 262_144, laneFullTimeoutMs: 20_000 }
    const a = await startNode({ prefix, register: [firehoseService], transport: { jetstream } })
    const b = await startNode({ prefix, transport: { jetstream } })

    try {
      const stats = await b.run(function* () {
        const reply: Reply = yield* Broker.actions.exchange('firehose', 'blast')

        if (reply.kind !== 'stream') {
          return yield* fail('test.expected-stream', `got a ${reply.kind} reply`)
        }

        return yield* scoped(function* () {
          const subscription = yield* reply.flow

          let bytes = 0
          let count = 0
          let ordered = true

          while (true) {
            const item = yield* subscription.next()

            if (item.done) {
              if (isFailure(item.value)) {
                return yield* item.value
              }

              return { bytes, count, ordered }
            }

            const chunk = item.value as Uint8Array

            if (chunk[0] !== count % 256) {
              ordered = false
            }

            bytes += chunk.length
            count += 1

            // the slow consumer: unacked frames pile up in the LANE workqueue behind this
            yield* sleep(1)
          }
        })
      })

      expect(stats.count).toBe(CHUNK_COUNT)
      expect(stats.bytes).toBe(CHUNK_COUNT * CHUNK_SIZE)
      expect(stats.ordered).toBe(true)

      // whitebox: the OWNER's pump must have parked at least once against the full stream
      const diag = (await a.run(() => NatsTransport.actions.diagnostics())) as {
        laneRetries: number
      }

      expect(diag.laneRetries).toBeGreaterThan(0)
    } finally {
      await b.close()
      await a.close()
    }
  }, 40_000)

  it('backpressure: a consumer that never reads fails the pump with lane-full', async () => {
    const prefix = freshPrefix()
    const jetstream = { laneMaxBytes: 65_536, laneFullTimeoutMs: 500 }
    const a = await startNode({ prefix, register: [firehoseService], transport: { jetstream } })
    const b = await startNode({ prefix, transport: { jetstream } })

    try {
      const kind = await b.run(function* () {
        const reply: Reply = yield* Broker.actions.exchange('firehose', 'blast')

        // deliberately NEVER subscribe reply.flow — no consumer ever drains the lane
        return reply.kind
      })

      expect(kind).toBe('stream')

      const diag = (await a.run(function* () {
        for (let poll = 0; poll < 100; poll += 1) {
          const snapshot = (yield* NatsTransport.actions.diagnostics()) as {
            laneRetries: number
            laneFailures: readonly string[]
          }

          if (snapshot.laneFailures.includes(NatsErrors.LaneFull)) {
            return snapshot
          }

          yield* sleep(100)
        }

        return yield* fail('test.no-lane-failure', 'the parked pump never gave up')
      })) as { laneRetries: number; laneFailures: readonly string[] }

      expect(diag.laneFailures).toContain(NatsErrors.LaneFull)
      expect(diag.laneRetries).toBeGreaterThan(0)
    } finally {
      await b.close()
      await a.close()
    }
  }, 30_000)

  it('abandoned: a remote detach handler sees the abort, finishes, and records the outcome', async () => {
    const prefix = freshPrefix()
    const a = await startNode({ prefix, register: [probeService] })

    const seen: unknown[] = []
    const b = await startNode({
      prefix,
      prepare: () =>
        Broker.actions.on('probe.done', payload => {
          seen.push(payload)
        }),
    })

    try {
      // call with the Service OBJECT: onDisconnect lives in the action meta, and only a caller
      // that can see the declaration resolves detach (a bare name string defaults to cancel)
      const failure = await b.result(() =>
        Broker.actions.call(probeService, 'detachProbe', undefined, {
          ackTimeoutMs: 5000,
          timeoutMs: 20,
        }),
      )

      expect(isFailure(failure)).toBe(true)

      if (!isFailure(failure)) {
        return
      }

      expect(failure.error).toBe(CoreErrors.TimeoutPending)

      const cid = cidOf(failure)

      // the detached handler keeps running, observes the fired signal, and broadcasts proof
      await b.run(function* () {
        for (let poll = 0; poll < 50 && seen.length === 0; poll += 1) {
          yield* sleep(100)
        }
      })

      expect(seen).toEqual([{ sawAbort: true }])

      // …and because the caller abandoned, the owner recorded the final outcome on the wire
      const stored = await b.run(function* () {
        for (let poll = 0; poll < 50; poll += 1) {
          const outcome = yield* NatsTransport.actions.outcome(cid)

          if (isJust(outcome)) {
            return outcome
          }

          yield* sleep(100)
        }

        return nothing<never>()
      })

      expect(isJust(stored)).toBe(true)

      if (isJust(stored)) {
        expect((stored.value as { state: string }).state).toBe('fulfilled')
      }
    } finally {
      await b.close()
      await a.close()
    }
  }, 30_000)

  it('durable events: a queue group replays the broadcasts it missed while down', async () => {
    const prefix = freshPrefix()
    const events = { durable: true, storage: 'memory' } as const
    const a = await startNode({ prefix, transport: { queueGroup: 'senders', events } })
    const b = await startNode({ prefix, transport: { queueGroup: 'listeners', events } })

    // the listeners group durable now exists — take its only member down
    await b.close()

    const seen: unknown[] = []
    let b2: Awaited<ReturnType<typeof startNode>> | undefined

    try {
      await a.run(() => Broker.actions.broadcast('deploy.done', { version: 7 }))

      // a NEW member of the same group attaches to the durable and receives the missed event
      b2 = await startNode({
        prefix,
        transport: { queueGroup: 'listeners', events },
        prepare: () =>
          Broker.actions.on('deploy.done', payload => {
            seen.push(payload)
          }),
      })

      await b2.run(function* () {
        for (let poll = 0; poll < 50 && seen.length === 0; poll += 1) {
          yield* sleep(100)
        }
      })

      expect(seen).toEqual([{ version: 7 }])
    } finally {
      await b2?.close()
      await a.close()
    }
  }, 30_000)
})

describe.skipIf(!natsTlsUrl || !natsTlsCaFile)(
  'nats transport over real TLS (docker-gated)',
  () => {
    // the passthrough hands `connection.tls` to transport-node verbatim; `caFile` pins the
    // throwaway CA the script minted, so the self-signed server chain actually verifies
    const tlsTransport = (): Partial<NatsTransportOptions> => ({
      servers: natsTlsUrl as string,
      connection: { tls: { caFile: natsTlsCaFile as string } },
    })

    it('cross-broker dispatch round-trips over a CA-verified TLS connection', async () => {
      const prefix = freshPrefix()
      const a = await startNode({
        prefix,
        register: [mathService('tls-owner')],
        transport: tlsTransport(),
      })
      const b = await startNode({ prefix, transport: tlsTransport() })

      try {
        expect(await b.run(() => Broker.actions.call('math', 'add', { a: 20, b: 22 }))).toBe(42)
        expect(await b.run(() => Broker.actions.call('math', 'whoami'))).toBe('tls-owner')
      } finally {
        await b.close()
        await a.close()
      }
    }, 20_000)

    it('without the CA the handshake is refused — proof the listener really is TLS', async () => {
      const outcome = await runResult(function* () {
        yield* bootstrap()

        // no `tls` options → the client upgrades with the default CA store, which cannot verify
        // the throwaway chain — the connect must fail CLEANLY with the connect tag
        yield* install(NatsTransport, {
          servers: natsTlsUrl as string,
          connection: { reconnect: false },
        })
      })

      expect(isFailure(outcome)).toBe(true)

      if (isFailure(outcome)) {
        expect(outcome.error).toBe(NatsErrors.Connect)
      }
    }, 15_000)
  },
)

describe.skipIf(!natsNkeyUrl || !natsNkeySeed)(
  'nats transport with nkey auth (docker-gated)',
  () => {
    // `connection.authenticator` rides the same passthrough — the seed signs the server nonce on
    // every (re)connect, so only the user the script minted into the server config gets in
    const nkeyTransport = (): Partial<NatsTransportOptions> => ({
      servers: natsNkeyUrl as string,
      connection: {
        authenticator: nkeyAuthenticator(new TextEncoder().encode(natsNkeySeed as string)),
      },
    })

    it('a seed-signed connection round-trips a cross-broker dispatch', async () => {
      const prefix = freshPrefix()
      const a = await startNode({
        prefix,
        register: [mathService('nkey-owner')],
        transport: nkeyTransport(),
      })
      const b = await startNode({ prefix, transport: nkeyTransport() })

      try {
        expect(await b.run(() => Broker.actions.call('math', 'add', { a: 40, b: 2 }))).toBe(42)
        expect(await b.run(() => Broker.actions.call('math', 'whoami'))).toBe('nkey-owner')
      } finally {
        await b.close()
        await a.close()
      }
    }, 20_000)

    it('anonymous connections are refused — proof authorization really is enforced', async () => {
      const outcome = await runResult(function* () {
        yield* bootstrap()
        yield* install(NatsTransport, {
          servers: natsNkeyUrl as string,
          connection: { reconnect: false },
        })
      })

      expect(isFailure(outcome)).toBe(true)

      if (isFailure(outcome)) {
        expect(outcome.error).toBe(NatsErrors.Connect)
      }
    }, 15_000)
  },
)
