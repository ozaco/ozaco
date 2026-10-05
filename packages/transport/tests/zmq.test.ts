import type { Operation } from 'std:effect'
import { attempt, createQueue, fork, run, scoped, sleep, suspend, withResolvers } from 'std:effect'
import type { IODef } from 'std:io'
import { IO } from 'std:io'
import { DefaultLogger, LogLevel } from 'std:logger'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { Transport, TransportErrors } from 'transport:core'
import { ZmqTransport, zmqEndpoint } from 'transport:impl/zmq'

import { zmtpLink } from '../src/impl/zmq/internal/link'
import { parseHeaders } from '../src/impl/zmq/internal/wire'
import {
  createDecoder,
  encodeMessage,
  encodeReady,
  greeting,
  parseReady,
} from '../src/impl/zmq/internal/zmtp'

import { capture, linesOf, settled } from './capture'
import { runTransportSuite } from './suite'

const tmp = process.env.TMPDIR ?? '/tmp'
const ipcPath = (): string => `${tmp}/ozaco-zmq-${crypto.randomUUID().slice(0, 8)}.sock`

// --- the full suite: one hub for the file, every install connects to it -------------------------

// the same hub serves the suite three times: over ipc (ZMTP on a unix socket), over tcp (ZMTP on
// a port) and in process (`inproc://` — the link pair every hub's own install uses too)
const suiteHub = (() => {
  const path = ipcPath()
  const stop = withResolvers<void>('suite hub stop')
  const ready = withResolvers<{ tcp: string }>('suite hub ready')
  const done = run(function* () {
    yield* BunIO.use()
    yield* ZmqTransport.use({ prefix: 'hub', bind: `ipc://${path}` })
    yield* scoped(function* () {
      yield* ZmqTransport.use({ prefix: 'hub-tcp', bind: 'tcp://127.0.0.1:0' })
      yield* ZmqTransport.use({ prefix: 'hub-inproc', bind: 'inproc://zmq-suite' })
      ready.resolve({ tcp: (yield* zmqEndpoint())! })
      yield* stop.operation
    })
  })

  return { ipc: `ipc://${path}`, inproc: 'inproc://zmq-suite', ready: ready.operation, stop, done }
})()

let tcpEndpoint = ''

beforeAll(async () => {
  tcpEndpoint = unwrap(await run(() => suiteHub.ready)).tcp
})

afterAll(async () => {
  suiteHub.stop.resolve()
  unwrap(await suiteHub.done)
})

for (const [name, endpoint] of [
  ['ipc', () => suiteHub.ipc],
  ['tcp', () => tcpEndpoint],
  ['inproc', () => suiteHub.inproc],
] as const) {
  describe(`over ${name}`, () => {
    runTransportSuite({
      label: 'zmq',
      enabled: true,
      use: (prefix = 'suite') => ZmqTransport.use({ prefix, connect: endpoint() }),
      expect: { receipts: true, requestReply: false, groups: true, durable: true },
    })
  })
}

// --- the other endpoints, the hub's own install, redials -------------------------------------

describe('transport — zmq: endpoints and lifecycle', () => {
  it('tcp: the hub binds an ephemeral port; peers in other scopes request/reply through it', async () => {
    unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* ZmqTransport.use({ prefix: 'app', bind: 'tcp://127.0.0.1:0' })

        const endpoint = yield* zmqEndpoint()

        expect(endpoint).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/u)
        expect(endpoint).not.toBe('tcp://127.0.0.1:0')

        // the hub's own install serves…
        yield* Transport.actions.serve<{ n: number }, number>('double', function* (args) {
          return args.n * 2
        })

        // …a peer over tcp asks
        const answer = yield* scoped(function* () {
          yield* BunIO.use()
          yield* ZmqTransport.use({ prefix: 'app', connect: endpoint! })

          return yield* Transport.actions.request<number>('double', { n: 21 })
        })

        expect(answer).toBe(42)
      }),
    )
  })

  it('inproc: a hub by name, found by any scope of the process', async () => {
    unwrap(
      await run(function* () {
        yield* BunIO.use()

        const topic = `in.${crypto.randomUUID().slice(0, 8)}`
        const ready = createQueue<void, void>()
        const hub = yield* fork(() =>
          scoped(function* () {
            yield* BunIO.use()
            yield* ZmqTransport.use({ prefix: 'app', bind: 'inproc://zmq-test-hub' })

            const sub = yield* Transport.actions.subscribe<string>(topic)

            ready.add(undefined)

            return ((yield* sub.next()) as AnyType).value.value as string
          }),
        )

        yield* ready.next()
        yield* scoped(function* () {
          yield* ZmqTransport.use({ prefix: 'app', connect: 'inproc://zmq-test-hub' })
          yield* sleep(50)
          yield* Transport.actions.publish(topic, 'in process')
        })
        expect(yield* hub).toBe('in process')

        // nobody bound once the hub scope is gone
        const orphan = yield* attempt(() =>
          ZmqTransport.use({
            prefix: 'app',
            connect: 'inproc://zmq-test-hub',
            connectTimeoutMs: 200,
          }),
        )

        expect(isFailure(orphan)).toBe(true)
        expect((orphan as AnyType).error).toBe(TransportErrors.Connection)
      }),
    )
  })

  it('a hub that comes back is redialled: status, subscriptions and durables survive', async () => {
    const path = ipcPath()
    const endpoint = `ipc://${path}`
    const topic = `re.${crypto.randomUUID().slice(0, 8)}`

    unwrap(
      await run(function* () {
        yield* BunIO.use()

        const firstStop = withResolvers<void>('first hub')
        const firstHub = yield* fork(() =>
          scoped(function* () {
            yield* ZmqTransport.use({ prefix: 'hub', bind: endpoint })
            yield* firstStop.operation
          }),
        )

        yield* sleep(50)
        yield* ZmqTransport.use({ prefix: 'app', connect: endpoint })

        const status = yield* Transport.actions.status()

        expect(((yield* status.next()) as AnyType).value).toBe('connected')

        const sub = yield* Transport.actions.subscribe<string>(topic, { durable: 'keep' })

        yield* Transport.actions.publish(topic, 'before')
        expect(((yield* sub.next()) as AnyType).value.value).toBe('before')

        // the hub goes away…
        firstStop.resolve()
        yield* firstHub
        expect(((yield* status.next()) as AnyType).value).toBe('reconnecting')

        // a publish made while down waits for the hub (a DEALER blocks on its HWM) — it lands
        // once the hub is back, before anything published after it
        const parked = yield* fork(() => Transport.actions.publish(topic, 'while down'))

        // …and comes back on the same endpoint: the peer redials and re-announces
        yield* fork(() =>
          scoped(function* () {
            yield* ZmqTransport.use({ prefix: 'hub', bind: endpoint })
            yield* suspend()
          }),
        )
        expect(((yield* status.next()) as AnyType).value).toBe('connected')
        yield* parked
        yield* Transport.actions.publish(topic, 'after')

        const heard: string[] = []

        for (let n = 0; n < 2; n += 1) {
          const step = yield* sub.next()

          heard.push((step as AnyType).value.value)
          yield* (step as AnyType).value.ack()
        }

        expect(heard).toEqual(['while down', 'after'])
      }),
    )
  })

  it('a call made while the hub is down fails after offlineTimeoutMs', async () => {
    const endpoint = `ipc://${ipcPath()}`

    unwrap(
      await run(function* () {
        yield* BunIO.use()

        const stop = withResolvers<void>('hub')
        const hub = yield* fork(() =>
          scoped(function* () {
            yield* ZmqTransport.use({ prefix: 'hub', bind: endpoint })
            yield* stop.operation
          }),
        )

        yield* sleep(50)
        yield* ZmqTransport.use({ prefix: 'app', connect: endpoint, offlineTimeoutMs: 200 })

        const status = yield* Transport.actions.status()

        yield* status.next()
        stop.resolve()
        yield* hub
        expect(((yield* status.next()) as AnyType).value).toBe('reconnecting')

        const startedAt = Date.now()
        const failed = yield* attempt(() => Transport.actions.publish('x', 1))

        expect(isFailure(failed)).toBe(true)
        expect((failed as AnyType).error).toBe(TransportErrors.Connection)
        expect((failed as AnyType).message).toBe('zmq hub unreachable for 200ms')
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190)
        expect(Date.now() - startedAt).toBeLessThan(2000)
      }),
    )
  })

  it('heartbeat: a peer that handshakes and then falls silent is dropped by the hub', async () => {
    unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* ZmqTransport.use({
          prefix: 'app',
          bind: 'tcp://127.0.0.1:0',
          heartbeat: { intervalMs: 50, timeoutMs: 150 },
        })

        const endpoint = yield* IO.actions.parseEndpoint((yield* zmqEndpoint())!)
        const socket = yield* IO.actions.tcpConnect(
          endpoint!.scheme === 'tcp'
            ? { hostname: endpoint!.host, port: endpoint!.port }
            : { path: '' },
        )

        // a raw ZMTP DEALER that completes the handshake, then never answers a PING
        yield* socket.write(greeting())
        yield* socket.write(encodeReady({ 'Socket-Type': 'DEALER' }))

        const startedAt = Date.now()
        const inbound = yield* socket.data
        let pings = 0

        for (;;) {
          const step = yield* inbound.next()

          if (step.done) {
            break
          }

          pings += step.value.some(byte => byte === 0x04) ? 1 : 0
        }

        // the hub pinged, heard nothing back for the timeout, and closed the socket
        expect(pings).toBeGreaterThanOrEqual(1)
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150)
        expect(Date.now() - startedAt).toBeLessThan(2000)
      }),
    )
  })

  it('heartbeat: a hub that falls silent is dropped by the peer, which redials', async () => {
    unwrap(
      await run(function* () {
        yield* BunIO.use()

        // a raw ZMTP ROUTER that handshakes, then never answers anything
        const server = yield* IO.actions.tcpListen(
          { port: 0, hostname: '127.0.0.1' },
          function* (socket) {
            yield* socket.write(greeting())
            yield* socket.write(encodeReady({ 'Socket-Type': 'ROUTER' }))
            yield* socket.closed
          },
        )

        yield* ZmqTransport.use({
          prefix: 'app',
          connect: `tcp://127.0.0.1:${server.port}`,
          heartbeat: { intervalMs: 50, timeoutMs: 150 },
        })

        const status = yield* Transport.actions.status()

        expect(((yield* status.next()) as AnyType).value).toBe('connected')
        expect(((yield* status.next()) as AnyType).value).toBe('reconnecting')
      }),
    )
  })

  it('ipc: a stale socket file (a crashed hub) is removed before binding; a live one is not', async () => {
    const path = ipcPath()

    unwrap(
      await run(function* () {
        yield* BunIO.use()
        // what a crash leaves behind: a socket file nobody listens on
        yield* scoped(function* () {
          yield* IO.actions.tcpListen({ path }, function* () {})
        })
        yield* IO.actions.write(path, new Uint8Array(0))
        expect(yield* IO.actions.exists(path)).toBe(true)

        yield* scoped(function* () {
          yield* ZmqTransport.use({ prefix: 'app', bind: `ipc://${path}` })
          expect(yield* zmqEndpoint()).toBe(`ipc://${path}`)

          // a second hub on the same live path must not steal it
          const taken = yield* attempt(() =>
            scoped(() => ZmqTransport.use({ prefix: 'other', bind: `ipc://${path}` })),
          )

          expect((taken as AnyType).error).toBe(TransportErrors.Connection)
          expect((taken as AnyType).message).toBe(`cannot bind ipc://${path}`)
        })
        // the hub removed its file on the way out
        expect(yield* IO.actions.exists(path)).toBe(false)
      }),
    )
  })

  it('two installs on one hub share a served group; another prefix never joins it', async () => {
    unwrap(
      await run(function* () {
        yield* BunIO.use()

        const topic = `grp.${crypto.randomUUID().slice(0, 8)}`
        const answered = { left: 0, right: 0, other: 0 }
        const serving = createQueue<void, void>()
        const member = (name: 'left' | 'right' | 'other', prefix: string) =>
          fork(() =>
            scoped(function* () {
              yield* BunIO.use()
              yield* ZmqTransport.use({ prefix, connect: suiteHub.ipc })
              yield* Transport.actions.serve(
                topic,
                function* () {
                  answered[name] += 1

                  return name
                },
                { group: 'workers' },
              )
              serving.add(undefined)
              yield* suspend()
            }),
          )

        const members = [
          yield* member('left', 'app'),
          yield* member('right', 'app'),
          // the same group name under ANOTHER application prefix: a different group
          yield* member('other', 'elsewhere'),
        ]

        for (let n = 0; n < 3; n += 1) {
          yield* serving.next()
        }

        yield* ZmqTransport.use({ prefix: 'app', connect: suiteHub.ipc })

        for (let n = 0; n < 8; n += 1) {
          expect(['left', 'right']).toContain(yield* Transport.actions.request(topic, {}))
        }

        expect(answered.left + answered.right).toBe(8)
        expect(answered.left).toBeGreaterThan(0)
        expect(answered.right).toBeGreaterThan(0)
        expect(answered.other).toBe(0)

        for (const task of members) {
          yield* task.halt()
        }
      }),
    )
  })

  it('connect before bind: a peer dialling an endpoint nobody holds yet joins when the hub appears', async () => {
    const endpoint = `ipc://${ipcPath()}`
    const topic = `late.${crypto.randomUUID().slice(0, 8)}`

    unwrap(
      await run(function* () {
        yield* BunIO.use()

        const hub = yield* fork(() =>
          scoped(function* () {
            yield* sleep(300)
            yield* ZmqTransport.use({ prefix: 'hub', bind: endpoint })
            yield* Transport.actions.serve(topic, function* () {
              return 'late but here'
            })
            yield* suspend()
          }),
        )

        yield* ZmqTransport.use({ prefix: 'hub', connect: endpoint, connectTimeoutMs: 2000 })
        expect(yield* zmqEndpoint()).toBeNull()
        yield* sleep(50)
        expect(yield* Transport.actions.request<string>(topic, {})).toBe('late but here')
        yield* hub.halt()
      }),
    )
  })

  it('the hub turns away what is not a zmq peer, and an incompatible socket type', async () => {
    unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* ZmqTransport.use({ prefix: 'app', bind: 'tcp://127.0.0.1:0' })

        const endpoint = yield* IO.actions.parseEndpoint((yield* zmqEndpoint())!)
        const dial = () =>
          IO.actions.tcpConnect(
            endpoint!.scheme === 'tcp'
              ? { hostname: endpoint!.host, port: endpoint!.port }
              : { path: '' },
          )
        /** true once the hub ended the connection (its FIN ends our inbound bytes) */
        const closedAfter = function* (write: (socket: IODef.TcpSocket) => Operation<void>) {
          return yield* scoped(function* () {
            const socket = yield* dial()
            const inbound = yield* socket.data

            yield* write(socket)

            for (;;) {
              const step = yield* inbound.next()

              if (step.done) {
                return true
              }
            }
          })
        }

        // an HTTP client: not ZMTP → the hub closes the socket
        expect(
          yield* closedAfter(function* (socket) {
            yield* socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'.padEnd(64, ' '))
          }),
        ).toBe(true)
        // a PUB socket: speaks ZMTP, but a ROUTER cannot talk to it
        expect(
          yield* closedAfter(function* (socket) {
            yield* socket.write(greeting())
            yield* socket.write(encodeReady({ 'Socket-Type': 'PUB' }))
          }),
        ).toBe(true)
      }),
    )
  })

  it('connection lost / back / closed reach the Logger under @ozaco/transport', async () => {
    const endpoint = `ipc://${ipcPath()}`
    const sink = capture()

    unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* DefaultLogger.use({ level: LogLevel.trace })
        yield* sink.plugin.use()

        const stop = withResolvers<void>('hub')
        const hub = yield* fork(() =>
          scoped(function* () {
            yield* ZmqTransport.use({ prefix: 'hub', bind: endpoint })
            yield* stop.operation
          }),
        )

        yield* sleep(50)
        yield* ZmqTransport.use({ prefix: 'app', connect: endpoint })
        stop.resolve()
        yield* hub
        yield* settled(sink.entries, 1)
        yield* fork(() =>
          scoped(function* () {
            yield* ZmqTransport.use({ prefix: 'hub', bind: endpoint })
            yield* suspend()
          }),
        )
        yield* settled(sink.entries, 2)
        yield* Transport.actions.drain()
        yield* settled(sink.entries, 3)
      }),
    )

    expect(linesOf(sink.entries).filter(line => !line.includes('hub'))).toEqual([
      'WARN transport connection lost',
      'INFO transport reconnected',
      'INFO transport closed',
    ])
    expect(sink.entries[0]?.data).toMatchObject({
      'messaging.system': 'zmq',
      'ozaco.prefix': 'app',
    })
  })

  it('a peer that dies without BYE mid-durable: what it held goes to the next member', async () => {
    const topic = `dur.${crypto.randomUUID().slice(0, 8)}`
    const text = (value: string) => new TextEncoder().encode(value)
    const str = (frame: Uint8Array | undefined) => new TextDecoder().decode(frame)

    unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* ZmqTransport.use({ prefix: 'app', bind: 'tcp://127.0.0.1:0' })

        const endpoint = yield* IO.actions.parseEndpoint((yield* zmqEndpoint())!)

        // a hand-driven ZMTP DEALER speaking the hub protocol — it will crash (no UNSUB, no BYE)
        const crashed = yield* scoped(function* () {
          const socket = yield* IO.actions.tcpConnect(
            endpoint!.scheme === 'tcp'
              ? { hostname: endpoint!.host, port: endpoint!.port }
              : { path: '' },
          )
          const link = yield* zmtpLink(socket, 'DEALER')

          // the frames ZmqTransport would send: pattern and durable name under the app prefix
          yield* link.send([
            text('SUB'),
            text('1'),
            text('sid-1'),
            text(`app.${topic}`),
            text(''),
            text('app.keep'),
          ])
          expect(((yield* link.messages.next()) as AnyType).value.map(str)).toEqual(['OK', '1'])

          yield* Transport.actions.publish(topic, 'held by the one that dies')

          const [cmd, sid, subject, seq] = ((yield* link.messages.next()) as AnyType).value.map(str)

          expect([cmd, sid, subject]).toEqual(['MSG', 'sid-1', `app.${topic}`])
          expect(seq).not.toBe('')

          // …and the process is gone: the socket just closes, nothing acked
          yield* socket.close()

          return true
        })

        expect(crashed).toBe(true)

        // the next member of the same durable gets what the dead one never acked
        const sub = yield* Transport.actions.subscribe<string>(topic, { durable: 'keep' })
        const step = yield* sub.next()

        expect((step as AnyType).value.value).toBe('held by the one that dies')
        yield* (step as AnyType).value.ack()
      }),
    )
  })

  it('a peer with nobody to dial fails the install with transport.connection', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()

      return {
        failure: yield* attempt(() =>
          ZmqTransport.use({
            prefix: 'app',
            connect: `ipc://${ipcPath()}`,
            connectTimeoutMs: 300,
          }),
        ),
      }
    })
    const { failure } = unwrap(outcome) as AnyType

    expect(isFailure(failure)).toBe(true)
    expect(failure.error).toBe(TransportErrors.Connection)
    expect(failure.message).toBe('cannot connect to the zmq hub')
    // the last dial's failure, nested
    expect(
      failure.causes.some((cause: AnyType) => cause?.error === 'std:io.tcp-connect-failed'),
    ).toBe(true)
  })

  it('rejects an endpoint it cannot parse', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()

      return {
        failure: yield* attempt(() => ZmqTransport.use({ prefix: 'app', bind: 'udp://x:1' })),
      }
    })

    expect((unwrap(outcome) as AnyType).failure.error).toBe(TransportErrors.Configuration)
  })
})

// --- ZMTP 3.1 bytes, against what libzmq 4.3.5 actually sends ----------------------------------

describe('transport — zmq: ZMTP 3.1 codec', () => {
  /** A libzmq 4.3.5 DEALER connecting to us (captured): signature, the rest of the greeting,
   * `READY` (Socket-Type DEALER, Identity empty), then the message
   * `['hello', 0x010203, 'a' × 300]` — the last frame long-sized. */
  const libzmq = Buffer.from(
    [
      'ff00000000000000017f',
      '03014e554c4c',
      '00'.repeat(16),
      '00',
      '00'.repeat(31),
      '04290552454144590b536f636b65742d54797065000000064445414c4552084964656e74697479000000',
      '00',
      '010568656c6c6f',
      '0103010203',
      '02000000000000012c',
      '61'.repeat(300),
    ].join(''),
    'hex',
  )

  it('reads a libzmq greeting, READY and message — in one chunk or byte by byte', () => {
    const whole = createDecoder().feed(new Uint8Array(libzmq))
    const trickled = createDecoder()
    const dripped = []

    for (const byte of libzmq) {
      dripped.push(...trickled.feed(Uint8Array.of(byte)))
    }

    for (const events of [whole, dripped]) {
      expect(events.map(event => event.t)).toEqual(['greeting', 'command', 'message'])
      expect(events[0]).toEqual({ t: 'greeting', minor: 1 })

      const ready = events[1] as AnyType

      expect(ready.name).toBe('READY')
      expect(parseReady(ready.data)).toEqual({ 'Socket-Type': 'DEALER', Identity: '' })

      const message = (events[2] as AnyType).frames as Uint8Array[]

      expect(message.map(frame => frame.length)).toEqual([5, 3, 300])
      expect(new TextDecoder().decode(message[0])).toBe('hello')
      expect([...message[1]!]).toEqual([1, 2, 3])
    }
  })

  it('writes what libzmq reads: our greeting, READY and frames round-trip through the decoder', () => {
    const ours = createDecoder()
    const long = new Uint8Array(70_000).fill(0x62)
    const events = [
      ...ours.feed(greeting()),
      ...ours.feed(encodeReady({ 'Socket-Type': 'ROUTER' })),
      ...ours.feed(encodeMessage([new TextEncoder().encode('x'), new Uint8Array(0), long])),
    ]

    expect(events.map(event => event.t)).toEqual(['greeting', 'command', 'message'])
    expect(parseReady((events[1] as AnyType).data)).toEqual({ 'Socket-Type': 'ROUTER' })
    expect(((events[2] as AnyType).frames as Uint8Array[]).map(frame => frame.length)).toEqual([
      1, 0, 70_000,
    ])
    // the greeting we send is byte-for-byte what the spec's NULL peer sends
    expect(greeting().length).toBe(64)
    expect([greeting()[0], greeting()[9], greeting()[10], greeting()[11]]).toEqual([
      0xff, 0x7f, 3, 1,
    ])
  })

  it('a headers frame that is not a JSON object of strings reads as no headers', () => {
    const text = (value: string) => new TextEncoder().encode(value)

    expect(parseHeaders(undefined)).toEqual({})
    expect(parseHeaders(text(''))).toEqual({})
    expect(parseHeaders(text('not json'))).toEqual({})
    expect(parseHeaders(text('[1,2]'))).toEqual({})
    expect(parseHeaders(text('{"a":"1","b":2,"c":null}'))).toEqual({ a: '1' })
  })

  it('a stream that is not ZMTP dies with one error event', () => {
    const decoder = createDecoder()
    const events = decoder.feed(new TextEncoder().encode('GET / HTTP/1.1\r\n'.padEnd(64, ' ')))

    expect(events).toEqual([{ t: 'error', reason: 'not a ZMTP 3 greeting' }])
    expect(decoder.feed(Uint8Array.of(1, 2, 3))).toEqual([])
  })
})
