/**
 * An upgrade the engine ACCEPTED but the runtime could not complete (Bun's `upgrade()` refusing
 * a malformed handshake, Deno's `upgradeWebSocket` throwing, `ws` aborting it): the upgrade span
 * `GET {route}` must end with what the client really got — never a 101 next to a 500 — through
 * the accept verdict's `failed(reason, status)`; a completed one still ends at the 101.
 */
import type { ServerDef } from 'server:core'
import { createServer, Edge, service } from 'server:core'
import type { Operation } from 'std:effect'
import { run, sleep, until } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { DefaultLogger, LoggerTransport, LogLevel } from 'std:logger'
import { definePlugin } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'

import { describe, expect, it } from 'bun:test'
import { connect } from 'node:net'

import { BunEdge } from 'server:impl/edge/bun'
import { DenoEdge, denoImpl } from 'server:impl/edge/deno'
import { NodeEdge } from 'server:impl/edge/node'

import { storage } from '../helpers'

const empty = service('empty', {})

/** An observe hook collecting every span and log record the kernel reports. */
const spy = () => {
  const spans: TraceDef.SpanData[] = []
  const logs: TraceDef.LogData[] = []

  const plugin = definePlugin<ServerDef.PluginContext, []>({
    name: 'spy',
    version: '0',
    description: 'captures observe events',
    *setup() {
      const hooks: ServerDef.Hooks = {
        name: 'spy',
        *observe(event) {
          if (event.t === 'span') {
            spans.push(event.span)
          } else {
            logs.push(event.log)
          }
        },
      }

      return { hooks }
    },
  }).build()

  /** the ONE upgrade span of `/live`. */
  const upgrade = (): TraceDef.SpanData => {
    const found = spans.filter(span => span.name === 'GET /live')

    expect(found).toHaveLength(1)

    return found[0]!
  }

  const exceptionsIn = (traceId: string): TraceDef.LogData[] =>
    logs.filter(
      log => log.context?.traceId === traceId && log.attributes['exception.type'] !== undefined,
    )

  return { plugin, spans, logs, upgrade, exceptionsIn }
}

/** A raw HTTP/1.1 exchange over TCP (a handshake no WebSocket client would send): the head of
 * whatever the server answers. */
const exchange = (port: number, head: string): Promise<string> =>
  new Promise((resolve, reject) => {
    let got = ''
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET /live HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${head}\r\n`)
    })
    const timer = setTimeout(() => socket.destroy(), 1000)

    socket.on('data', chunk => {
      got += String(chunk)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(got)
    })
    socket.on('error', reject)
  })

/** An upgrade Bun / Deno cannot complete: no `Sec-WebSocket-Key`. */
const KEYLESS = 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'

/** One `ws` aborts (400): a key that is not a base64 nonce. */
const BAD_KEY = `${KEYLESS}Sec-WebSocket-Key: nope\r\n`

/** A real client: open, get the greeting, close. */
const greet = (url: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url)

    ws.addEventListener('message', event => {
      resolve(JSON.parse(String(event.data)))
      ws.close()
    })
    ws.addEventListener('error', () => reject(new Error('socket error')))
  })

/** Boot a node on `edge` with a `/live` socket route, then run `body` against its port. */
const withEdge = async (
  edge: AnyType,
  options: { plugins?: AnyType[]; before?: () => Operation<void> },
  body: (info: { url: string; port: number }) => Operation<void>,
): Promise<void> => {
  unwrap(
    await run(function* () {
      yield* storage()

      if (options.before) {
        yield* options.before()
      }

      const server = yield* createServer({ services: [empty], edge, plugins: options.plugins })

      yield* Edge.actions.socket({
        path: '/live',
        *handler(socket) {
          yield* socket.send({ t: 'hello' })

          const messages = yield* socket.messages

          yield* messages.next()
        },
      })

      const info = yield* server.start({ port: 0 })

      yield* body({ url: info.url!, port: info.port! })
      // the span of a refused upgrade ends from the edge's scope: let that run
      yield* sleep(50)
      yield* server.stop()
    }),
  )
}

/** A Deno runtime over `Bun.serve` whose `upgradeWebSocket` throws, like Deno's does on a
 * request it cannot upgrade. */
const throwingDeno = () => ({
  serve(
    options: { port?: number; hostname?: string; onListen?: (addr: AnyType) => void },
    handler: (request: Request) => Response | Promise<Response>,
  ) {
    const server = Bun.serve({
      port: options.port ?? 0,
      hostname: options.hostname ?? '127.0.0.1',
      fetch: request => handler(request),
    })
    const addr = { port: Number(server.port), hostname: String(server.hostname) }

    options.onListen?.(addr)

    return { addr, shutdown: () => Promise.resolve(server.stop(true)) }
  },
  upgradeWebSocket(): never {
    throw new TypeError("Invalid Header: 'sec-websocket-key' header must be set")
  },
})

describe('edge — an accepted upgrade the runtime could not complete', () => {
  it('bun: `upgrade()` refused ⇒ the span ends with the 500 the client got, ONE ERROR record', async () => {
    const seen = spy()
    let answer = ''

    await withEdge(BunEdge, { plugins: [seen.plugin.use()] }, function* (info) {
      answer = yield* until(exchange(info.port, KEYLESS))
    })

    expect(answer.startsWith('HTTP/1.1 500')).toBe(true)

    const upgrade = seen.upgrade()

    expect(upgrade.attributes).toMatchObject({
      'http.response.status_code': 500,
      'error.type': 'server.internal',
    })
    expect(upgrade.status.code).toBe('error')

    const recorded = seen.exceptionsIn(upgrade.context.traceId)

    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.severityNumber).toBe(17)
    expect(recorded[0]!.context?.spanId).toBe(upgrade.context.spanId)
  })

  it('bun: a completed upgrade still ends its span at the 101', async () => {
    const seen = spy()

    await withEdge(BunEdge, { plugins: [seen.plugin.use()] }, function* (info) {
      expect(yield* until(greet(`${info.url.replace('http', 'ws')}/live`))).toEqual({ t: 'hello' })
    })

    const upgrade = seen.upgrade()

    expect(upgrade.attributes['http.response.status_code']).toBe(101)
    expect(upgrade.attributes['error.type']).toBeUndefined()
    expect(upgrade.status.code).toBe('unset')
    expect(seen.exceptionsIn(upgrade.context.traceId)).toEqual([])
  })

  it('node: `ws` aborting the handshake ⇒ its 400 (unset + error.type, DEBUG), never a 101', async () => {
    const seen = spy()
    let answer = ''

    await withEdge(NodeEdge, { plugins: [seen.plugin.use()] }, function* (info) {
      answer = yield* until(exchange(info.port, BAD_KEY))
      // …and a well-formed one still upgrades
      expect(yield* until(greet(`${info.url.replace('http', 'ws')}/live`))).toEqual({ t: 'hello' })
    })

    expect(answer.startsWith('HTTP/1.1 400')).toBe(true)

    const [refused, upgraded] = seen.spans
      .filter(span => span.name === 'GET /live')
      .toSorted((left, right) => left.start - right.start)

    expect(refused!.attributes).toMatchObject({
      'http.response.status_code': 400,
      'error.type': 'server.bad-request',
    })
    expect(refused!.status.code).toBe('unset')

    const recorded = seen.exceptionsIn(refused!.context.traceId)

    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.severityNumber).toBe(5)

    expect(upgraded!.attributes['http.response.status_code']).toBe(101)
  })

  it("deno: a throwing `upgradeWebSocket` ⇒ 500, the runtime's error kept as the cause", async () => {
    const seen = spy()
    let answer = ''

    await withEdge(
      DenoEdge.use(),
      {
        plugins: [seen.plugin.use()],
        *before() {
          yield* denoImpl.set(throwingDeno() as AnyType)
        },
      },
      function* (info) {
        answer = yield* until(exchange(info.port, KEYLESS))
      },
    )

    expect(answer.startsWith('HTTP/1.1 500')).toBe(true)

    const upgrade = seen.upgrade()

    expect(upgrade.attributes).toMatchObject({
      'http.response.status_code': 500,
      'error.type': 'server.internal',
    })
    expect(upgrade.status.code).toBe('error')

    const recorded = seen.exceptionsIn(upgrade.context.traceId)

    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.attributes['ozaco.failure.chain']).toEqual([
      'server.internal: the runtime could not complete the websocket upgrade',
      "std:result.unknown: TypeError: Invalid Header: 'sec-websocket-key' header must be set",
    ])
  })

  it('tracing off: no span can hold it — ONE WARN Logger line instead', async () => {
    const entries: LoggerDef.Entry[] = []
    const Capture = LoggerTransport.implement({
      name: 'test/capture-transport',
      version: '1.0.0',
      *setup() {
        return { name: 'capture', level: LogLevel.trace }
      },
    }).build({
      *write(entry: LoggerDef.Entry) {
        entries.push(entry)
      },
      *flush() {},
      *close() {},
    })

    await withEdge(
      BunEdge,
      {
        *before() {
          yield* DefaultLogger.use({ level: LogLevel.info })
          yield* Capture.use()
        },
      },
      function* (info) {
        expect(yield* until(exchange(info.port, KEYLESS))).toStartWith('HTTP/1.1 500')
      },
    )

    const lines = entries.filter(entry => entry.msg === 'edge upgrade failed')

    expect(lines).toHaveLength(1)
    expect(lines[0]!.level).toBe(LogLevel.warn)
    expect(lines[0]!.bindings['logger']).toBe('@ozaco/server')
  })
})
