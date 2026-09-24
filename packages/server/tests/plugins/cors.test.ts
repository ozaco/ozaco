import { createServer, Edge } from 'server:core'
import { Cors } from 'server:plugins'
import { run, until } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunEdge } from 'server:impl/edge/bun'

import { storage, todos } from '../helpers'

describe('cors', () => {
  it('decorates responses for allowed origins and answers preflights', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [Cors.use({ origins: ['https://app.test'], credentials: true })],
        })
        yield* server.start()
        const allowed = yield* Edge.actions.handle(
          new Request('http://edge/todos/list', { headers: { origin: 'https://app.test' } }),
        )
        expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.test')
        expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')
        expect(allowed.headers.get('access-control-expose-headers')).toContain('x-request-id')
        // errors are decorated too
        const missing = yield* Edge.actions.handle(
          new Request('http://edge/nope', { headers: { origin: 'https://app.test' } }),
        )
        expect(missing.status).toBe(404)
        expect(missing.headers.get('access-control-allow-origin')).toBe('https://app.test')
        // a foreign origin gets nothing
        const foreign = yield* Edge.actions.handle(
          new Request('http://edge/todos/list', { headers: { origin: 'https://evil.test' } }),
        )
        expect(foreign.headers.get('access-control-allow-origin')).toBeNull()
        // preflight
        const preflight = yield* Edge.actions.handle(
          new Request('http://edge/todos/create', {
            method: 'OPTIONS',
            headers: { origin: 'https://app.test', 'access-control-request-method': 'POST' },
          }),
        )
        expect(preflight.status).toBe(204)
        expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')
        expect(preflight.headers.get('access-control-max-age')).toBe('600')
        yield* server.stop()
      }),
    )
  })

  it('keeps the content-type a Bun.file body brings along (decorated, request id stamped)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oz-cors-'))
    const file = join(dir, 'page.html')
    writeFileSync(file, '<b>hi</b>')

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [Cors.use({ origins: ['https://app.test'] })],
        })
        const info = yield* server.start({ port: 0 })
        yield* Edge.actions.raw({
          method: 'GET',
          path: '/page',
          *handler() {
            return new Response(Bun.file(file))
          },
        })
        const response = yield* Edge.actions.handle(
          new Request('http://edge/page', { headers: { origin: 'https://app.test' } }),
        )
        expect(response.headers.get('access-control-allow-origin')).toBe('https://app.test')
        expect(response.headers.get('content-type')).toContain('text/html')
        expect(response.headers.get('x-request-id')).toBeTruthy()
        expect(yield* until(response.text())).toBe('<b>hi</b>')

        // over a real socket too: the driver's body tracking keeps it as well
        const served = yield* until(
          fetch(`${info.url}/page`, { headers: { origin: 'https://app.test' } }),
        )
        expect(served.headers.get('content-type')).toContain('text/html')
        expect(served.headers.get('access-control-allow-origin')).toBe('https://app.test')
        expect(yield* until(served.text())).toBe('<b>hi</b>')
        yield* server.stop()
      }),
    )
  })
})
