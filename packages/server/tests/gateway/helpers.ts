import type { GatewayInfo, Multistream } from 'server:core'
import {
  Broker,
  chunks,
  DataType,
  DefaultGateway,
  defineAction,
  defineService,
  Gateway,
  parts,
  stream,
  useResponse,
  useSource,
  useTrace,
  value,
} from 'server:core'
import type { Operation } from 'std:effect'
import { each, flow, operation, until } from 'std:effect'
import type { Plugin } from 'std:plugin'
import { install } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType, EmptyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { bootstrap } from '../core/helpers'
import { runScoped } from '../helpers'

const TodoErrors = { NotFound: 'todos.not-found' } as const

const numbers = () =>
  flow<{ n: number }, unknown>(
    (async function* generate() {
      yield { n: 1 }
      yield { n: 2 }
      yield { n: 3 }
    })(),
  )

const bytes = () =>
  flow<Uint8Array, unknown>(
    (async function* generate() {
      yield new Uint8Array([1, 2])
      yield new Uint8Array([3, 4])
    })(),
  )

export const fixtureService = () =>
  defineService({
    name: 'todos',
    version: '1.0.0',
    actions: {
      get: defineAction(
        {
          input: z.object({ id: z.string() }),
          route: { method: 'GET', path: '/:id' },
          errors: { [TodoErrors.NotFound]: 404 },
        },
        function* (body) {
          if (body.id === 'missing') {
            return yield* fail(TodoErrors.NotFound, `todo "${body.id}" not found`)
          }

          const trace = yield* useTrace()

          return { id: body.id, requestId: trace.requestId, lane: trace.lane.map(h => h.service) }
        },
      ),
      list: defineAction(
        { input: z.object({ q: z.string().optional() }), route: { method: 'GET', path: '/' } },
        function* (body) {
          return { q: body.q ?? null, items: ['a', 'b'] }
        },
      ),
      create: defineAction(
        { input: z.object({ title: z.string() }), route: { method: 'POST', path: '/' } },
        function* (body) {
          const res = yield* useResponse()

          res.status = 201
          res.meta['x-created'] = 'yes'

          return { title: body.title }
        },
      ),
      remove: defineAction(
        { input: z.object({ id: z.string() }), route: { method: 'DELETE', path: '/:id' } },
        function* () {
          // returns undefined → 204
        },
      ),
      tail: defineAction(
        { output: stream(), route: { method: 'GET', path: '/feed/sse', sse: true } },
        function* () {
          return numbers() as never
        },
      ),
      lines: defineAction(
        { output: stream(), route: { method: 'GET', path: '/feed/lines' } },
        function* () {
          return numbers() as never
        },
      ),
      blob: defineAction(
        { output: chunks(), route: { method: 'GET', path: '/feed/blob' } },
        function* () {
          return bytes() as never
        },
      ),
      upload: defineAction(
        {
          input: [value(z.object({ note: z.string() })), parts()],
          route: { method: 'POST', path: '/upload' },
        },
        function* (body) {
          const source = (yield* useSource(DataType.multistream)) as Multistream
          const seen: { name: string; size: number }[] = []

          for (const part of yield* each(source.parts)) {
            if (part.kind === 'file') {
              let size = 0

              for (const chunk of yield* each(part.data)) {
                size += chunk.byteLength
                yield* each.next()
              }

              seen.push({ name: part.filename, size })
            }

            yield* each.next()
          }

          return { note: body.note, files: seen }
        },
      ),
    },
  })

export interface GatewayTarget {
  readonly label: string
  readonly enabled: boolean
  readonly websocket: boolean
  readonly adapter: Plugin<AnyType, [], EmptyType>
  readonly prepare?: (() => Operation<void>) | undefined
}

export const bootGateway = operation(function* (target: GatewayTarget) {
  yield* bootstrap()

  const todos = fixtureService()

  yield* Broker.actions.register(todos)

  if (target.prepare) {
    yield* target.prepare()
  }

  yield* install(target.adapter)
  yield* install(DefaultGateway, { name: 'gw' })
  yield* Gateway.actions.mount('/todos', todos)

  const info: GatewayInfo = yield* Gateway.actions.start({ port: 0 })

  return info
})

/** Runs a full websocket round trip: send frames after open, resolve on `expected` messages. */
export const wsExchange = (
  url: string,
  sends: readonly string[],
  expected: number,
): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const received: string[] = []
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`ws timeout — got ${received.length}/${expected}: ${received.join(',')}`))
    }, 3000)

    socket.addEventListener('open', () => {
      for (const message of sends) {
        socket.send(message)
      }

      if (expected === 0) {
        clearTimeout(timer)
        socket.close()
        resolve(received)
      }
    })

    socket.addEventListener('message', event => {
      received.push(String(event.data))

      if (received.length >= expected) {
        clearTimeout(timer)
        socket.close()
        resolve(received)
      }
    })

    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('ws error'))
    })
  })

export const runGatewaySuite = (target: GatewayTarget): void => {
  describe(`gateway over ${target.label}`, () => {
    if (!target.enabled) {
      it.skip(`${target.label} disabled in this environment`, () => {})

      return
    }

    it('routes path + query + body and echoes x-request-id', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootGateway(target)

        const get = yield* until(
          fetch(`${info.url}/todos/42`, {
            headers: { 'x-request-id': 'fixed-id_123' },
          }),
        )
        const got = (yield* until(get.json())) as { id: string; requestId: string; lane: string[] }

        const list = yield* until(fetch(`${info.url}/todos?q=abc`))
        const listed = (yield* until(list.json())) as { q: string | null }

        const created = yield* until(
          fetch(`${info.url}/todos`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"title":"hi"}',
          }),
        )
        const createdBody = (yield* until(created.json())) as { title: string }

        return {
          got,
          echoed: get.headers.get('x-request-id'),
          listed,
          createdStatus: created.status,
          createdHeader: created.headers.get('x-created'),
          createdBody,
        }
      })

      expect(result.got.id).toBe('42')
      expect(result.got.requestId).toBe('fixed-id_123')
      expect(result.got.lane).toEqual(['gw', 'todos'])
      expect(result.echoed).toBe('fixed-id_123')
      expect(result.listed.q).toBe('abc')
      expect(result.createdStatus).toBe(201)
      expect(result.createdHeader).toBe('yes')
      expect(result.createdBody.title).toBe('hi')
    })

    it('maps failures: tag status, requestId in body, minted id on invalid header', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootGateway(target)

        const missing = yield* until(
          fetch(`${info.url}/todos/missing`, { headers: { 'x-request-id': 'bad id!!' } }),
        )
        const body = (yield* until(missing.json())) as {
          error: string
          requestId: string
        }

        const unknown = yield* until(fetch(`${info.url}/nope`))
        const validation = yield* until(
          fetch(`${info.url}/todos`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"title":42}',
          }),
        )

        return {
          status: missing.status,
          body,
          header: missing.headers.get('x-request-id'),
          unknownStatus: unknown.status,
          validationStatus: validation.status,
        }
      })

      expect(result.status).toBe(404)
      expect(result.body.error).toBe(TodoErrors.NotFound)
      expect(result.body.requestId).toMatch(/^r_/u)
      expect(result.header).toBe(result.body.requestId)
      expect(result.unknownStatus).toBe(404)
      expect(result.validationStatus).toBe(400)
    })

    it('returns 204 for undefined results', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootGateway(target)
        const res = yield* until(fetch(`${info.url}/todos/9`, { method: 'DELETE' }))

        return { status: res.status }
      })

      expect(result.status).toBe(204)
    })

    it('streams: SSE framing, NDJSON fallback and raw bytes', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootGateway(target)

        const sse = yield* until(fetch(`${info.url}/todos/feed/sse`))
        const sseText = yield* until(sse.text())

        const lines = yield* until(fetch(`${info.url}/todos/feed/lines`))
        const linesText = yield* until(lines.text())

        const blob = yield* until(fetch(`${info.url}/todos/feed/blob`))
        const buffer = new Uint8Array(yield* until(blob.arrayBuffer()))

        return {
          sseType: sse.headers.get('content-type'),
          sseText,
          linesType: lines.headers.get('content-type'),
          linesText,
          blobType: blob.headers.get('content-type'),
          buffer: [...buffer],
        }
      })

      expect(result.sseType).toContain('text/event-stream')
      expect(result.sseText).toContain(': ok')
      expect(result.sseText).toContain('data: {"n":1}')
      expect(result.sseText).toContain('data: {"n":3}')
      expect(result.linesType).toContain('application/x-ndjson')
      expect(result.linesText.trim().split('\n')).toHaveLength(3)
      expect(result.blobType).toContain('application/octet-stream')
      expect(result.buffer).toEqual([1, 2, 3, 4])
    })

    it('parses multipart: leading fields become params, files stream as parts', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootGateway(target)
        const form = new FormData()

        form.append('note', 'hello')
        form.append('doc', new Blob([new Uint8Array(64)]), 'doc.bin')

        const res = yield* until(fetch(`${info.url}/todos/upload`, { method: 'POST', body: form }))
        const body = (yield* until(res.json())) as {
          note: string
          files: { name: string; size: number }[]
        }

        return { status: res.status, body }
      })

      expect(result.status).toBe(200)
      expect(result.body.note).toBe('hello')
      expect(result.body.files).toEqual([{ name: 'doc.bin', size: 64 }])
    })

    it('pauses with 503 and resumes', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootGateway(target)

        yield* Gateway.actions.pause()

        const paused = yield* until(fetch(`${info.url}/todos/1`))

        yield* Gateway.actions.resume()

        const resumed = yield* until(fetch(`${info.url}/todos/1`))

        return {
          pausedStatus: paused.status,
          pausedId: paused.headers.get('x-request-id'),
          resumedStatus: resumed.status,
        }
      })

      expect(result.pausedStatus).toBe(503)
      expect(result.pausedId).toMatch(/^r_/u)
      expect(result.resumedStatus).toBe(200)
    })

    if (target.websocket) {
      it('serves websocket routes: echo, params, rooms', async () => {
        const result = await runScoped(function* () {
          const info = yield* bootGateway(target)

          yield* Gateway.actions.socket('/ws/:room', {
            *open(socket) {
              socket.send(`welcome:${socket.params['room']}`)
            },
            *message(socket, data) {
              const text = String(data)

              if (text === 'join') {
                socket.join(socket.params['room'] ?? '')
                socket.send('joined')

                return
              }

              if (text.startsWith('room:')) {
                yield* socket.toRoom(socket.params['room'] ?? '', text.slice(5))

                return
              }

              socket.send(`echo:${text}`)
            },
          })

          const wsUrl = `ws://127.0.0.1:${info.port}/ws/lobby`
          const echo = yield* until(wsExchange(wsUrl, ['ping'], 2))

          return { echo }
        })

        expect(result.echo).toEqual(['welcome:lobby', 'echo:ping'])
      })

      it('rejects unknown socket paths with 404 and unauthorized with 401', async () => {
        const result = await runScoped(function* () {
          const info = yield* bootGateway(target)

          yield* Gateway.actions.socket('/ws/guarded', {
            *authorize(request) {
              return request.headers['authorization'] === 'Bearer ok'
            },
            *message() {},
          })

          const reject = (url: string) =>
            new Promise<boolean>(resolve => {
              const socket = new WebSocket(url)
              let settled = false
              const settle = (outcome: boolean) => {
                if (!settled) {
                  settled = true
                  resolve(outcome)
                }
              }
              const timer = setTimeout(() => {
                socket.close()
                settle(false)
              }, 2000)

              socket.addEventListener('open', () => {
                clearTimeout(timer)
                socket.close()
                settle(false)
              })
              socket.addEventListener('error', () => {
                clearTimeout(timer)
                settle(true)
              })
            })

          const unknownRejected = yield* until(reject(`ws://127.0.0.1:${info.port}/ws/nope`))
          const guardRejected = yield* until(reject(`ws://127.0.0.1:${info.port}/ws/guarded`))
          const allowed = yield* until(
            wsExchange(`ws://127.0.0.1:${info.port}/ws/guarded?token=ok`, [], 0).then(
              () => true,
              () => false,
            ),
          )

          return { unknownRejected, guardRejected, allowed }
        })

        expect(result.unknownRejected).toBe(true)
        expect(result.guardRejected).toBe(true)
        expect(result.allowed).toBe(true)
      })
    }
  })
}
