// oxlint-disable import/exports-last
import type { ServerDef } from 'server:core'
import { action, createServer, Edge, HEADERS, Observe, service, stream } from 'server:core'
import { ObservePlugin } from 'server:plugins'
import type { Operation } from 'std:effect'
import { run, sleep, until } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { storage, todos } from '../helpers'

export interface EdgeTarget {
  readonly label: string
  readonly enabled: boolean
  /** the edge entry `createServer` installs. */
  readonly edge: ServerDef.PluginLike
  /** whether the runtime can really listen (sockets/streams go over a port). */
  readonly listens: boolean
  /** runs before `createServer` (inject fakes into the scope). */
  readonly install?: (() => Operation<void>) | undefined
}

/** Extra actions the suite needs beyond the shared `todos` service. */
const media = service('media', {
  upload: action.mutation(
    {
      input: stream.parts({
        fields: z.object({ album: z.string() }),
        streams: { photo: stream.bytes('image/*') },
      }),
      output: z.object({ album: z.string(), bytes: z.number() }),
    },
    function* ({ input }) {
      let bytes = 0
      const photo = yield* stream.flow(input.streams.photo)
      for (;;) {
        const step = yield* photo.next()
        if (step.done) {
          break
        }
        bytes += step.value.length
      }
      return { album: input.fields.album, bytes }
    },
  ),
  raw: action.mutation(
    { input: stream.bytes('application/octet-stream'), output: z.object({ sum: z.number() }) },
    function* ({ input }) {
      let sum = 0
      const body = yield* stream.flow(input)
      for (;;) {
        const step = yield* body.next()
        if (step.done) {
          break
        }
        for (const byte of step.value) {
          sum += byte
        }
      }
      return { sum }
    },
  ),
  download: action.stream({ output: stream.bytes('text/plain') }, function* () {
    return stream.from(new Blob(['hello ', 'bytes']).stream(), 'bytes:text/plain')
  }),
  ticks: action.stream(
    { input: z.object({ n: z.number() }), output: stream.sse(z.object({ i: z.number() })) },
    function* ({ input }) {
      return {
        *[Symbol.iterator]() {
          let i = 0
          return {
            *next() {
              if (i >= input.n) {
                return { done: true as const, value: undefined }
              }
              yield* sleep(5)
              return { done: false as const, value: { i: i++ } }
            },
          }
        },
      }
    },
  ),
  echo: action.query(
    {
      input: z.object({ n: z.number(), tags: z.array(z.string()).optional() }),
      output: z.any(),
      route: { method: 'GET', path: '/echo/:n' },
    },
    function* ({ input }) {
      return input
    },
  ),
})

const boot = function* (target: EdgeTarget): Operation<ServerDef.Handle<AnyType>> {
  yield* storage()
  if (target.install) {
    yield* target.install()
  }
  return yield* createServer({
    services: [todos, media],
    edge: target.edge,
    plugins: [ObservePlugin.use({ batch: { ms: 5 } })],
  })
}

const fetchJson = function* (
  path: string,
  init?: RequestInit,
): Operation<{ status: number; body: AnyType; headers: Headers }> {
  const response = yield* Edge.actions.handle(new Request(`http://edge${path}`, init))
  const text = yield* until(response.text())
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  }
}

export const runEdgeSuite = (target: EdgeTarget): void => {
  describe.skipIf(!target.enabled)(`edge — ${target.label}`, () => {
    it('routes actions by kind/path, validates, echoes x-request-id, renders failures', async () => {
      unwrap(
        await run(function* () {
          yield* boot(target)
          const created = yield* fetchJson('/todos/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json', [HEADERS.requestId]: 'req-abc' },
            body: JSON.stringify({ title: 'edge' }),
          })
          expect(created.status).toBe(200)
          expect(created.body).toMatchObject({ title: 'edge', done: false })
          expect(created.headers.get(HEADERS.requestId)).toBe('req-abc')

          // GET query → value plane, coerced by the schema's eyes
          const listed = yield* fetchJson('/todos/list?done=false')
          expect(listed.status).toBe(200)
          expect(listed.body).toHaveLength(1)
          // path params + repeated query keys
          const echoed = yield* fetchJson('/echo/42?tags=a&tags=b')
          expect(echoed.body).toEqual({ n: 42, tags: ['a', 'b'] })

          const invalid = yield* fetchJson('/todos/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: '' }),
          })
          expect(invalid.status).toBe(400)
          expect(invalid.body.error.error).toBe('server.validation')
          expect(invalid.headers.get(HEADERS.requestId)).toBeTruthy()
          expect(invalid.headers.get(HEADERS.error)).toBe('server.validation')

          const missing = yield* fetchJson('/nope')
          expect(missing.status).toBe(404)
          const badJson = yield* fetchJson('/todos/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{not json',
          })
          expect(badJson.status).toBe(400)
          expect(badJson.body.error.error).toBe('server.bad-request')
          const custom = yield* fetchJson('/todos/explode?code=todo.kaput')
          expect(custom.status).toBe(500)
          expect(custom.body.error).toMatchObject({
            error: 'todo.kaput',
            message: 'boom todo.kaput',
          })
          // the request row knows the edge: method, path, status, error tag
          yield* sleep(30)
          const page = yield* Observe.actions.query({ status: 'failed' })
          expect(
            page.requests.map(row => `${row.method} ${row.path} ${row.status} ${row.error}`),
          ).toContain('GET /todos/explode 500 todo.kaput')
        }),
      )
    })

    it('decorators run on every response; preflight answers unrouted OPTIONS; pause → 503', async () => {
      unwrap(
        await run(function* () {
          yield* boot(target)
          yield* Edge.actions.decorate(function* (_request, response) {
            const out = new Response(response.body, response)
            out.headers.set('x-decorated', 'yes')
            return out
          })
          yield* Edge.actions.preflight(function* (request) {
            return request.headers.get('origin') ? new Response(null, { status: 204 }) : null
          })
          const ok = yield* fetchJson('/todos/list')
          expect(ok.headers.get('x-decorated')).toBe('yes')
          const missing = yield* fetchJson('/nope')
          expect(missing.headers.get('x-decorated')).toBe('yes')
          const preflight = yield* fetchJson('/anything', {
            method: 'OPTIONS',
            headers: { origin: 'https://x' },
          })
          expect(preflight.status).toBe(204)
          yield* Edge.actions.pause()
          expect((yield* fetchJson('/todos/list')).status).toBe(503)
          yield* Edge.actions.resume()
          expect((yield* fetchJson('/todos/list')).status).toBe(200)
          // raw routes bypass the action model
          yield* Edge.actions.raw({
            method: 'GET',
            path: '/health/:name',
            *handler(_request, params) {
              return Response.json({ ok: true, name: params.name })
            },
          })
          expect((yield* fetchJson('/health/db')).body).toEqual({ ok: true, name: 'db' })
        }),
      )
    })

    it('branded streams: bytes in/out, multipart parts, ndjson and sse bodies', async () => {
      unwrap(
        await run(function* () {
          yield* boot(target)
          // bytes in
          const raw = yield* fetchJson('/media/raw', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: new Uint8Array([1, 2, 3, 250]),
          })
          expect(raw.body).toEqual({ sum: 256 })
          // multipart: fields before files
          const form = new FormData()
          form.append('album', 'summer')
          form.append('photo', new Blob([new Uint8Array(1000)], { type: 'image/png' }), 'a.png')
          const uploaded = yield* fetchJson('/media/upload', { method: 'POST', body: form })
          expect(uploaded.body).toEqual({ album: 'summer', bytes: 1000 })
          // bytes out
          const download = yield* Edge.actions.handle(new Request('http://edge/media/download'))
          expect(download.headers.get('content-type')).toBe('text/plain')
          expect(download.headers.get(HEADERS.brand)).toBe('bytes:text/plain')
          expect(yield* until(download.text())).toBe('hello bytes')
          // ndjson out
          const count = yield* Edge.actions.handle(new Request('http://edge/todos/count?n=3'))
          expect(count.headers.get('content-type')).toBe('application/x-ndjson')
          expect(yield* until(count.text())).toBe('0\n1\n2\n')
          // sse out
          const ticks = yield* Edge.actions.handle(new Request('http://edge/media/ticks?n=2'))
          expect(ticks.headers.get('content-type')).toBe('text/event-stream')
          // an sse body opens with a comment so the headers flush before the first event
          expect(yield* until(ticks.text())).toBe(': ok\n\ndata: {"i":0}\n\ndata: {"i":1}\n\n')
        }),
      )
    })

    it.skipIf(!target.listens)(
      'listens on a port: HTTP over the wire and a socket route',
      async () => {
        unwrap(
          await run(function* () {
            const server = yield* boot(target)
            const heard: unknown[] = []
            yield* Edge.actions.socket({
              path: '/live/:room',
              *authorize(request) {
                if (new URL(request.url).searchParams.get('token') !== 'ok') {
                  return yield* fail('server.unauthorized', 'no token')
                }
              },
              *handler(socket) {
                yield* socket.send({ hello: socket.params.room })
                for (;;) {
                  const step = yield* (yield* socket.messages).next()
                  if (step.done) {
                    return
                  }
                  heard.push(step.value)
                  yield* socket.send({ echo: step.value })
                }
              },
            })
            const info = yield* server.listen({ port: 0 })
            expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
            const response = yield* until(fetch(`${info.url}/todos/list`))
            expect(response.status).toBe(200)
            expect(yield* until(response.json())).toEqual([])

            // a streamed body over the wire keeps pumping after the response headers went out
            const ticks = yield* until(fetch(`${info.url}/media/ticks?n=3`))
            expect(yield* until(ticks.text())).toBe(
              ': ok\n\ndata: {"i":0}\n\ndata: {"i":1}\n\ndata: {"i":2}\n\n',
            )

            const wsUrl = info.url!.replace('http', 'ws')
            const denied = yield* until(
              new Promise<number>(resolve => {
                const ws = new WebSocket(`${wsUrl}/live/a`)
                ws.addEventListener('error', () => resolve(1))
                ws.addEventListener('close', () => resolve(1))
                ws.addEventListener('open', () => resolve(0))
              }),
            )
            expect(denied).toBe(1)
            const frames = yield* until(
              new Promise<unknown[]>(resolve => {
                const got: unknown[] = []
                const ws = new WebSocket(`${wsUrl}/live/lobby?token=ok`)
                ws.addEventListener('message', event => {
                  got.push(JSON.parse(String(event.data)))
                  if (got.length === 1) {
                    ws.send(JSON.stringify({ n: 1 }))
                  }
                  if (got.length === 2) {
                    ws.close()
                    resolve(got)
                  }
                })
              }),
            )
            expect(frames).toEqual([{ hello: 'lobby' }, { echo: { n: 1 } }])
            expect(heard).toEqual([{ n: 1 }])
            yield* server.stop()
          }),
        )
      },
    )
  })
}
