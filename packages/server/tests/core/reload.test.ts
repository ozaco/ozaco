/**
 * `server.reload(services)` — the declarations swap in place on a running node: handlers,
 * routes and the manifest change; the edge keeps its raw routes; plugin services survive; a bad
 * declaration leaves everything as it was. This is the primitive `HotReload` drives.
 */
import type { ServerDef } from 'server:core'
import { action, createServer, Edge, refs, service, ServerErrors } from 'server:core'
import { attempt, run, until } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { z } from 'zod'

import { storage } from '../helpers'

const greeter = (greeting: string) =>
  service('greeter', {
    hello: action.query(
      { input: z.object({ name: z.string() }), output: z.string() },
      function* ({ input }) {
        return `${greeting}, ${input.name}`
      },
    ),
  })

const extra = service('extra', {
  ping: action.query({ output: z.string() }, function* () {
    return 'pong'
  }),
  // a thrown (non-Result) error: the wire says WHAT went wrong under `server.internal`
  boom: action.query({ output: z.string() }, function* () {
    return yield* until(Promise.reject(new Error('page build exploded')))
  }),
})

const get = function* (path: string) {
  const response = yield* Edge.actions.handle(new Request(`http://edge${path}`))
  return { status: response.status, body: yield* until(response.text()) }
}

describe('kernel — reload', () => {
  it('swaps handlers, adds and removes services, remounts the edge, keeps raw routes', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [greeter('hello')], edge: BunEdge })
        yield* server.start()
        yield* Edge.actions.raw({
          method: 'GET',
          path: '/plain',
          *handler() {
            return new Response('plain')
          },
        })

        expect(
          yield* server.call(refs<ReturnType<typeof greeter>>('greeter').hello, { name: 'a' }),
        ).toBe('hello, a')
        expect((yield* get('/greeter/hello?name=a')).body).toBe('"hello, a"')
        expect((yield* get('/extra/ping')).status).toBe(404)

        const report = yield* server.reload([greeter('hi'), extra])
        expect(report).toEqual({
          added: ['extra'],
          removed: [],
          replaced: ['greeter'],
          actions: 3,
          sockets: 0,
        })

        // the new handler serves — in-process and over the edge
        expect(
          yield* server.call(refs<ReturnType<typeof greeter>>('greeter').hello, { name: 'a' }),
        ).toBe('hi, a')
        expect((yield* get('/greeter/hello?name=a')).body).toBe('"hi, a"')

        // the added service is routed, hosted, documented
        expect((yield* get('/extra/ping')).body).toBe('"pong"')
        const boom = yield* get('/extra/boom')
        expect(boom.status).toBe(500)
        expect(JSON.parse(boom.body).error).toMatchObject({
          error: ServerErrors.Internal,
          message: 'page build exploded',
        })
        expect(yield* server.call(extra, 'ping')).toBe('pong')
        expect((yield* server.members('extra')).length).toBe(1)
        const manifest = yield* server.manifest()
        expect(manifest.actions.map(entry => `${entry.service}.${entry.action}`)).toEqual([
          'greeter.hello',
          'extra.ping',
          'extra.boom',
        ])

        // raw routes registered on the edge survive the remount
        expect((yield* get('/plain')).body).toBe('plain')
        expect((yield* get('/_health')).status).toBe(200)

        // removing a service unmounts and unhosts it: a call goes looking over the carrier
        // like any undeclared service would, and the local one honestly has nobody
        const gone = yield* server.reload([extra])
        expect(gone.removed).toEqual(['greeter'])
        expect((yield* get('/greeter/hello?name=a')).status).toBe(404)
        const missing = yield* attempt(
          server.call(refs<ReturnType<typeof greeter>>('greeter').hello, { name: 'a' }),
        )
        expect((missing as AnyType).error).toBe(ServerErrors.Unavailable)
        expect(yield* server.members('greeter')).toEqual([])

        yield* server.stop()
      }),
    )
  })

  it('is atomic: an invalid declaration fails and the running one keeps serving', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [greeter('hello')] })

        // an option no installed plugin handles
        const bad = service('bad', {
          x: action.query({ cache: { ttlMs: 5 } } as AnyType, function* () {}),
        })
        const rejected = yield* attempt(server.reload([greeter('hi'), bad]))
        expect((rejected as AnyType).error).toBe(ServerErrors.Configuration)

        // a duplicate name
        const twice = yield* attempt(server.reload([greeter('hi'), greeter('hey')]))
        expect((twice as AnyType).error).toBe(ServerErrors.Configuration)

        expect(
          yield* server.call(refs<ReturnType<typeof greeter>>('greeter').hello, { name: 'a' }),
        ).toBe('hello, a')
      }),
    )
  })

  it('keeps plugin-registered services and runs the reload hook', async () => {
    const reports: ServerDef.ReloadReport[] = []
    const mine = service('mine', {
      who: action.query({ output: z.string() }, function* () {
        return 'plugin'
      }),
    })
    const Mine = definePlugin<ServerDef.PluginContext, []>({
      name: 'test-mine',
      version: '0.0.0',
      *setup() {
        return {
          services: [mine],
          hooks: {
            name: 'mine',
            *reload(report) {
              reports.push(report)
            },
          },
        }
      },
    }).build()

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [greeter('hello')], plugins: [Mine] })

        const report = yield* server.reload([greeter('hi')])
        expect(report.replaced).toEqual(['greeter'])
        expect(reports).toEqual([report])
        expect(yield* server.call(mine, 'who')).toBe('plugin')

        // an application declaration cannot take a plugin service's name
        const clash = yield* attempt(server.reload([service('mine', {})]))
        expect((clash as AnyType).error).toBe(ServerErrors.Configuration)
        expect(yield* server.call(mine, 'who')).toBe('plugin')
      }),
    )
  })
})
