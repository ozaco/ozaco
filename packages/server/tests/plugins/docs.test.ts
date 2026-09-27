import { action, createServer, Edge, ServerErrors, service } from 'server:core'
import type { DocsDef } from 'server:plugins'
import { Auth, Docs, manifestSchema, ObservePlugin, Resilience, StaticAuth } from 'server:plugins'
import type { Operation } from 'std:effect'
import { attempt, run, sleep, until } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { enableTracing, Tracer } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'

import { storage, todos } from '../helpers'

let installs = 0

/** An in-memory std:trace `Tracer` installed around the server: every exported span. */
const memoryTracer = () => {
  installs += 1
  const spans: TraceDef.SpanData[] = []

  const plugin = Tracer.implement({
    name: `test/docs-tracer-${installs}`,
    version: '1.0.0',
    *setup() {
      yield* enableTracing()
      return {}
    },
  }).build({
    *export(data: TraceDef.SpanData) {
      spans.push(data)
    },
    *emit() {},
  })

  /** the exported edge spans of the requests to `path`. */
  const edgesOf = (path: string): TraceDef.SpanData[] =>
    spans.filter(data => data.kind === 'server' && data.attributes['url.path'] === path)

  return { plugin, spans, edgesOf }
}

/** The docs routes fetched under the in-memory tracer: each with and without a bearer. */
const tracedDocs = async (options: DocsDef.Options) => {
  const memory = memoryTracer()
  const statuses: Record<string, number> = {}

  const fetchDocs = function* (path: string, headers: Record<string, string>): Operation<void> {
    const response = yield* Edge.actions.handle(new Request(`http://edge${path}`, { headers }))
    yield* until(response.text())
    // a raw route's span ends with its body, from the edge's scope: let that run
    yield* sleep(5)
    statuses[`${path} ${headers.authorization ? 'bearer' : 'anonymous'}`] = response.status
  }

  unwrap(
    await run(function* () {
      yield* storage()
      yield* memory.plugin.use()
      const server = yield* createServer({
        services: [todos],
        edge: BunEdge,
        plugins: [
          StaticAuth.use({ tokens: { 'tok-docs': { sub: 'docs' } } }),
          Auth,
          Docs.use({ auth: 'authenticated', ...options }),
        ],
      })
      yield* server.start()
      for (const path of ['/docs', '/docs/manifest', '/docs/openapi.json']) {
        yield* fetchDocs(path, { authorization: 'Bearer tok-docs' })
        yield* fetchDocs(path, {})
      }
      yield* server.stop()
    }),
  )

  return { memory, statuses }
}

describe('docs', () => {
  it('serves the manifest (schemas, planes, brands, options) and a CDN-free panel', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          name: 'demo',
          version: '2.0.0',
          plugins: [
            ObservePlugin.use({ console: true }),
            Resilience,
            Docs.use({ path: '/docs', title: 'demo api' }),
          ],
        })
        yield* server.start()
        const response = yield* Edge.actions.handle(new Request('http://edge/docs/manifest'))
        expect(response.status).toBe(200)
        const manifest = (yield* until(response.json())) as AnyType
        expect(manifestSchema.safeParse(manifest).success).toBe(true)
        expect(manifest.name).toBe('demo')
        expect(manifest.observe.console).toBe('/_observe')
        expect(manifest.docs).toEqual({ path: '/docs', openapi: '/docs/openapi.json' })
        const todosDoc = manifest.services.find((entry: { name: string }) => entry.name === 'todos')
        const create = todosDoc.actions.find(
          (entry: { action: string }) => entry.action === 'create',
        )
        expect(create.kind).toBe('mutation')
        expect(create.route).toEqual({ method: 'POST', path: '/todos/create' })
        expect(create.input.schema.properties.title.type).toBe('string')
        expect(create.input.schema.properties.title.minLength).toBe(1)
        expect(create.output.schema.required).toEqual(['id', 'title', 'done'])
        expect(JSON.stringify(manifest)).not.toContain('$schema')
        const count = todosDoc.actions.find((entry: { action: string }) => entry.action === 'count')
        expect(count.output).toMatchObject({
          plane: 'stream',
          brand: 'ndjson',
          contentType: 'application/x-ndjson',
        })
        expect(count.output.schema.type).toBe('number')
        const slow = todosDoc.actions.find((entry: { action: string }) => entry.action === 'slow')
        expect(slow.options).toEqual({})
        expect(manifest.errors['server.not-found']).toBe(404)

        const openapi = yield* Edge.actions.handle(new Request('http://edge/docs/openapi.json'))
        expect(openapi.status).toBe(200)
        const oas = (yield* until(openapi.json())) as AnyType
        expect(oas.openapi).toBe('3.1.0')
        expect(oas.info).toEqual({ title: 'demo', version: '2.0.0' })
        const createOp = oas.paths['/todos/create'].post
        expect(createOp.operationId).toBe('todos.create')
        expect(createOp.summary).toBe('todos.create')
        expect(createOp.requestBody.content['application/json'].schema.properties.title.type).toBe(
          'string',
        )
        expect(createOp.responses['200'].content['application/json'].schema.required).toEqual([
          'id',
          'title',
          'done',
        ])

        const panel = yield* Edge.actions.handle(new Request('http://edge/docs'))
        expect(panel.headers.get('content-type')).toContain('text/html')
        const html = yield* until(panel.text())
        expect(html).toContain('demo api')
        expect(html).not.toMatch(/https?:\/\/(cdn|unpkg|jsdelivr)/u)
        // the observe console is mounted too
        const console = yield* Edge.actions.handle(new Request('http://edge/_observe'))
        expect(console.status).toBe(200)
        const live = yield* Edge.actions.handle(new Request('http://edge/_observe/api/traces'))
        expect(live.status).toBe(200)
        yield* server.stop()
      }),
    )
  })

  it('a failure response documents the REAL failure body: `{ error: { … } }`, causes strings or nested failures', async () => {
    const shop = service('shop', {
      gone: action.query(
        { route: { method: 'GET', path: '/shop/gone' }, errors: { 'shop.gone': 410 } },
        function* () {
          return yield* fail('shop.gone', 'sold out', 'shop:stock', fail('shop.db', 'no rows'))
        },
      ),
    })

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [shop],
          edge: BunEdge,
          plugins: [Docs.use({ path: '/docs' })],
        })
        yield* server.start()
        const openapi = yield* Edge.actions.handle(new Request('http://edge/docs/openapi.json'))
        const oas = (yield* until(openapi.json())) as AnyType
        const schema =
          oas.paths['/shop/gone'].get.responses['410'].content['application/json'].schema
        expect(schema.required).toEqual(['error'])
        const envelope = schema.properties.error
        expect(envelope.properties.causes.items.oneOf.map((item: AnyType) => item.type)).toEqual([
          'string',
          'object',
        ])

        // the body the edge really answers has every field the schema requires
        const failed = yield* Edge.actions.handle(new Request('http://edge/shop/gone'))
        expect(failed.status).toBe(410)
        const body = (yield* until(failed.json())) as AnyType
        expect(Object.keys(body)).toEqual(['error'])
        for (const key of envelope.required) {
          expect(body.error).toHaveProperty(key)
        }
        // a cause is a string — or a nested failure of the documented shape (chain exposed)
        for (const cause of body.error.causes as unknown[]) {
          if (typeof cause !== 'string') {
            expect(cause).toMatchObject({ _t: 'std:result:failure' })
          }
        }
        yield* server.stop()
      }),
    )
  })

  it('`auth` gates every docs route through Auth; the manifest documents the install default', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [
            StaticAuth.use({ tokens: { 'tok-docs': { sub: 'docs' } } }),
            Auth.use({ default: 'authenticated' }),
            Docs.use({ auth: 'authenticated' }),
          ],
        })
        yield* server.start()
        for (const path of ['/docs', '/docs/manifest', '/docs/openapi.json']) {
          const denied = yield* Edge.actions.handle(new Request(`http://edge${path}`))
          expect(denied.status).toBe(401)
          const allowed = yield* Edge.actions.handle(
            new Request(`http://edge${path}`, { headers: { authorization: 'Bearer tok-docs' } }),
          )
          expect(allowed.status).toBe(200)
        }
        const response = yield* Edge.actions.handle(
          new Request('http://edge/docs/manifest', {
            headers: { authorization: 'Bearer tok-docs' },
          }),
        )
        const manifest = (yield* until(response.json())) as AnyType
        expect(manifestSchema.safeParse(manifest).success).toBe(true)
        // `todos.list` sets no `auth` of its own: documented as what the install default makes it
        const todosDoc = manifest.services.find((entry: { name: string }) => entry.name === 'todos')
        const list = todosDoc.actions.find((entry: { action: string }) => entry.action === 'list')
        expect(list.auth).toEqual({ kind: 'authenticated' })
        yield* server.stop()
      }),
    )

    // gating without the Auth plugin is a configuration failure at start (a fresh scope: the
    // Auth context above is scope-bound and would otherwise still be visible here)
    unwrap(
      await run(function* () {
        yield* storage()
        const bare = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [Docs.use({ auth: 'authenticated' })],
        })
        const started = yield* attempt(bare.start())
        expect((started as AnyType).error).toBe(ServerErrors.Configuration)
      }),
    )
  })

  it("its routes are quiet by default (`observe: 'errors'`): only a failing fetch is traced", async () => {
    const { memory, statuses } = await tracedDocs({})

    for (const path of ['/docs', '/docs/manifest', '/docs/openapi.json']) {
      expect(statuses[`${path} bearer`]).toBe(200)
      expect(statuses[`${path} anonymous`]).toBe(401)
      // the successful fetch left nothing; the refused one kept its span, the failure on it
      const [refused, ...more] = memory.edgesOf(path)
      expect(more).toEqual([])
      expect(refused!.name).toBe(`GET ${path}`)
      expect(refused!.attributes['http.response.status_code']).toBe(401)
      expect(refused!.attributes['error.type']).toBe(ServerErrors.Unauthorized)
    }
  })

  it("`observe: 'on'` traces every fetch; `'off'` none — not even a failing one", async () => {
    const loud = await tracedDocs({ observe: 'on' })

    for (const path of ['/docs', '/docs/manifest', '/docs/openapi.json']) {
      expect(
        loud.memory.edgesOf(path).map(data => data.attributes['http.response.status_code']),
      ).toEqual([200, 401])
    }

    const off = await tracedDocs({ observe: 'off' })

    expect(off.statuses['/docs/manifest anonymous']).toBe(401)
    expect(off.memory.spans).toEqual([])
  })
})
