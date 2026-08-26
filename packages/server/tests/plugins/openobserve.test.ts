import { createServer, report, Server } from 'server:core'
import { attempt, run, sleep, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { OpenObserveExporter } from 'server:plugins/observe/openobserve'

import { storage, todos } from '../helpers'

describe('observe/openobserve', () => {
  it('ships requests, spans, logs and failures to per-kind streams; outages never surface', async () => {
    const received: { url: string; auth: string | undefined; body: AnyType }[] = []
    let failing = false
    const fakeFetch = ((url: AnyType, init: AnyType) => {
      if (failing) {
        return Promise.resolve(new Response('nope', { status: 503 }))
      }
      received.push({
        url: String(url),
        auth: init.headers['authorization'],
        body: JSON.parse(init.body),
      })
      return Promise.resolve(new Response('{"status":[]}', { status: 200 }))
    }) as typeof fetch
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          name: 'oo-demo',
          plugins: [
            OpenObserveExporter.use({
              url: 'http://openobserve:5080/',
              org: 'dev',
              auth: { user: 'root@local', pass: 'secret' },
              fetch: fakeFetch,
              batch: { ms: 20 },
              resource: { environment: 'test' },
            }),
          ],
        })
        yield* server.listen()
        yield* server.call(todos, 'create', { title: 'observed' })
        yield* attempt(server.call(todos, 'explode', { code: 'x.y' }))
        yield* sleep(80)

        // every payload hits the org's bulk `_json` endpoint with basic auth
        const basic = `Basic ${btoa('root@local:secret')}`
        for (const entry of received) {
          expect(entry.url).toMatch(/^http:\/\/openobserve:5080\/api\/dev\/\w+\/_json$/u)
          expect(entry.auth).toBe(basic)
        }

        const streamOf = (name: string) =>
          received
            .filter(entry => entry.url.endsWith(`/api/dev/${name}/_json`))
            .flatMap(entry => entry.body)
        const spans = streamOf('spans')
        const create = spans.find((row: AnyType) => row.name === 'todos.create')
        expect(create).toMatchObject({
          kind: 'dispatch',
          status: 'ok',
          service_name: 'oo-demo',
          environment: 'test',
        })
        expect(typeof create._timestamp).toBe('number')
        expect(create.duration_ms).toBeGreaterThanOrEqual(0)
        const explode = spans.find((row: AnyType) => row.name === 'todos.explode')
        expect(explode.status).toBe('failed')

        const requests = streamOf('requests')
        expect(requests.some((row: AnyType) => row.action === 'create')).toBe(true)

        const logs = streamOf('logs')
        const creating = logs.find((row: AnyType) => row.msg === 'creating')
        expect(creating.level).toBe('info')
        expect(creating.request_id).toBeDefined()
        expect(creating.request_id).toBe(create.request_id)

        const failures = streamOf('failures')
        expect(failures.find((row: AnyType) => row.tag === 'x.y')).toBeDefined()

        // an OpenObserve outage is counted, never raised into the caller
        failing = true
        const sent = received.length
        const made = yield* server.call(todos, 'create', { title: 'unsent' })
        expect(made.title).toBe('unsent')
        yield* sleep(80)
        expect(received.length).toBe(sent)
        yield* server.stop()
      }),
    )
  })

  it('bodies: request records carry headers/input/output — success included', async () => {
    const received: AnyType[] = []
    const fakeFetch = ((url: AnyType, init: AnyType) => {
      if (String(url).endsWith('/requests/_json')) {
        received.push(...JSON.parse(init.body))
      }
      return Promise.resolve(new Response('{"status":[]}', { status: 200 }))
    }) as typeof fetch
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          name: 'oo-bodies',
          edge: BunEdge,
          plugins: [
            OpenObserveExporter.use({
              url: 'http://oo:5080',
              bodies: true,
              fetch: fakeFetch,
              batch: { ms: 20 },
            }),
          ],
        })
        const info = yield* server.listen({ port: 0 })
        yield* until(
          fetch(`${info.url!}/todos/create`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
            body: JSON.stringify({ title: 'carried' }),
          }),
        )
        yield* sleep(80)

        const row = received.find(entry => entry.action === 'create' && entry.input)
        expect(row).toBeDefined()
        expect(row.input).toMatchObject({ kind: 'data', data: { title: 'carried' } })
        expect(row.output.kind).toBe('data')
        // secrets never leave: the authorization header ships redacted
        expect(row.headers.authorization).not.toContain('secret')
        yield* server.stop()
      }),
    )
  })

  it('bearer auth, renamed and disabled streams', async () => {
    const received: { url: string; auth: string | undefined }[] = []
    const fakeFetch = ((url: AnyType, init: AnyType) => {
      received.push({ url: String(url), auth: init.headers['authorization'] })
      return Promise.resolve(new Response('{"status":[]}', { status: 200 }))
    }) as typeof fetch
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          name: 'oo-demo',
          plugins: [
            OpenObserveExporter.use({
              url: 'http://openobserve:5080',
              auth: { token: 'tkn' },
              streams: { spans: 'app_spans', logs: false, events: false },
              fetch: fakeFetch,
              batch: { ms: 20 },
            }),
          ],
        })
        yield* server.listen()
        yield* server.call(todos, 'create', { title: 'renamed' })
        yield* sleep(80)

        expect(received.length).toBeGreaterThan(0)
        expect(received.every(entry => entry.auth === 'Bearer tkn')).toBe(true)
        expect(received.some(entry => entry.url.endsWith('/api/default/app_spans/_json'))).toBe(
          true,
        )
        expect(received.some(entry => entry.url.includes('/logs/'))).toBe(false)
        yield* server.stop()
      }),
    )
  })

  it('domain records ship to the `domain` stream (renameable), free-form fields intact', async () => {
    const received: { url: string; body: AnyType }[] = []
    const fakeFetch = ((url: AnyType, init: AnyType) => {
      received.push({ url: String(url), body: JSON.parse(init.body) })
      return Promise.resolve(new Response('{"status":[]}', { status: 200 }))
    }) as typeof fetch
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          name: 'oo-domain',
          plugins: [
            OpenObserveExporter.use({
              url: 'http://openobserve:5080',
              org: 'dev',
              streams: { domain: 'clarvia_audit' },
              fetch: fakeFetch,
              batch: { ms: 20 },
            }),
          ],
        })
        yield* server.listen()
        const kernel = yield* Server.actions.describe()
        yield* report(kernel, {
          t: 'domain',
          row: { stream: 'audit', actor: 'u-ada', verb: 'document.signed', document: 'd-1' },
        })
        yield* sleep(80)
        const rows = received
          .filter(entry => entry.url.endsWith('/api/dev/clarvia_audit/_json'))
          .flatMap(entry => entry.body)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          stream: 'audit',
          actor: 'u-ada',
          verb: 'document.signed',
          document: 'd-1',
          service_name: 'oo-domain',
        })
        expect(typeof rows[0]._timestamp).toBe('number')

        // the observe db never stores domain rows — they are exporter-bound
        yield* server.stop()
      }),
    )
  })
})
