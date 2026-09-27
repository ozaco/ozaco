/**
 * `OpenObserveExporter`: the OTLP encoder + transport against OpenObserve's OTLP endpoints
 * (`/api/<org>/v1/{traces,logs,metrics}`), Basic / Bearer auth, the `stream-name` header — and
 * nothing else: no `_json` side streams, the same records every sink holds.
 */
import { createServer, Server } from 'server:core'
import { attempt, run, sleep } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { OpenObserveExporter } from 'server:plugins/observe/openobserve'

import { storage, todos } from '../helpers'

import { attrOf, attrsOf, fakeCollector } from './otlp-wire'

describe('observe/openobserve', () => {
  it('ships spans, logs and metrics over OTLP/protobuf to /api/<org>/v1/* with basic auth + stream-name', async () => {
    const collector = fakeCollector()

    const stats = unwrap(
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
              stream: { traces: 'app_traces', logs: 'app_logs' },
              fetch: collector.fetch,
              batch: { waitMs: 20 },
              metrics: { intervalMs: 60_000 },
            }),
          ],
        })
        yield* server.start()
        yield* server.call(todos, 'create', { title: 'observed' })
        yield* attempt(server.call(todos, 'explode', { code: 'x.y' }))
        yield* sleep(60)
        yield* server.stop()

        return (yield* OpenObserveExporter.context.expect()).stats()
      }),
    )

    const basic = `Basic ${btoa('root@local:secret')}`

    expect(collector.received.length).toBeGreaterThan(0)

    for (const entry of collector.received) {
      // OTLP only — no `_json` stream is ever written
      expect(entry.url).toMatch(/^http:\/\/openobserve:5080\/api\/dev\/v1\/(traces|logs|metrics)$/u)
      expect(entry.headers['authorization']).toBe(basic)
      expect(entry.headers['content-type']).toBe('application/x-protobuf')
    }

    expect(collector.of('/v1/traces')[0]!.headers['stream-name']).toBe('app_traces')
    expect(collector.of('/v1/logs')[0]!.headers['stream-name']).toBe('app_logs')
    expect(collector.of('/v1/metrics')[0]!.headers['stream-name']).toBeUndefined()

    const spans = collector.spans()
    const create = spans.find(span => span.name === 'todos.create')
    expect(create).toMatchObject({ $service: 'todos', kind: 1 })
    const explode = spans.find(span => span.name === 'todos.explode')
    expect(explode.status).toEqual({ code: 2, message: 'boom x.y' })

    const logs = collector.logs()
    const creating = logs.find(record => record.body.stringValue === 'creating')
    expect(creating.traceId).toBe(create.traceId)
    expect(creating.spanId).toBe(create.spanId)
    // OpenObserve keeps EventName (o2_event_name) — and every sink has `otel.event.name` too
    const exception = logs.find(record => record.eventName === 'ozaco.action.exception')
    expect(attrOf(exception, 'otel.event.name')).toBe('ozaco.action.exception')

    expect(collector.metrics().some(metric => metric.name === 'ozaco.action.duration')).toBe(true)
    expect(stats.spans.sent).toBeGreaterThan(0)
    expect(stats.spans.failed).toBe(0)
  })

  it('bearer auth, one stream name for both signals, OTLP/JSON on request', async () => {
    const collector = fakeCollector()

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          plugins: [
            OpenObserveExporter.use({
              url: 'http://openobserve:5080',
              auth: { token: 'tkn' },
              stream: 'app',
              encoding: 'json',
              fetch: collector.fetch,
              batch: { waitMs: 20 },
              metrics: false,
            }),
          ],
        })
        yield* server.start()
        yield* server.call(todos, 'create', { title: 'renamed' })
        yield* server.stop()
      }),
    )

    expect(collector.received.length).toBeGreaterThan(0)

    for (const entry of collector.received) {
      expect(entry.url).toMatch(/^http:\/\/openobserve:5080\/api\/default\/v1\/(traces|logs)$/u)
      expect(entry.headers['authorization']).toBe('Bearer tkn')
      expect(entry.headers['stream-name']).toBe('app')
      expect(entry.headers['content-type']).toBe('application/json')
    }

    expect(collector.spans().some(span => span.name === 'todos.create')).toBe(true)
  })

  it('basic auth credentials are UTF-8 (a non-Latin-1 password never fails the install)', async () => {
    const collector = fakeCollector()

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          plugins: [
            OpenObserveExporter.use({
              url: 'http://openobserve:5080',
              auth: { user: 'kök@ozaco.dev', pass: 'şifre-Ğ1!' },
              fetch: collector.fetch,
              batch: { waitMs: 10 },
              metrics: false,
            }),
          ],
        })
        yield* server.start()
        yield* server.call(todos, 'create', { title: 'utf8' })
        yield* server.stop()
      }),
    )

    const header = collector.received[0]!.headers['authorization']!
    expect(header.startsWith('Basic ')).toBe(true)
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(header.slice('Basic '.length)), char => char.codePointAt(0)!),
    )
    expect(decoded).toBe('kök@ozaco.dev:şifre-Ğ1!')
  })

  it('a domain record is a log record (eventName ozaco.domain) like in every other sink', async () => {
    const collector = fakeCollector()

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
              fetch: collector.fetch,
              batch: { waitMs: 20 },
              metrics: false,
            }),
          ],
        })
        yield* server.start()
        yield* Server.actions.report({
          stream: 'audit',
          actor: 'u-ada',
          verb: 'document.signed',
          document: 'd-1',
        })
        yield* server.stop()
      }),
    )

    const domain = collector.logs().find(record => record.eventName === 'ozaco.domain')
    expect(domain).toBeDefined()
    expect(attrsOf(domain)).toMatchObject({
      'ozaco.domain.stream': 'audit',
      'otel.event.name': 'ozaco.domain',
    })
    expect(domain.$service).toBe('oo-domain')
  })

  it('an OpenObserve outage is counted, never raised into the caller', async () => {
    const collector = fakeCollector(() => new Response('nope', { status: 503 }))

    const stats = unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          plugins: [
            OpenObserveExporter.use({
              url: 'http://openobserve:5080',
              fetch: collector.fetch,
              batch: { waitMs: 10 },
              retry: { attempts: 2, initialMs: 1, maxMs: 1 },
              metrics: false,
            }),
          ],
        })
        yield* server.start()
        const made = yield* server.call(todos, 'create', { title: 'unsent' })
        expect(made.title).toBe('unsent')
        yield* server.stop()

        return (yield* OpenObserveExporter.context.expect()).stats()
      }),
    )

    expect(stats.spans.failed).toBeGreaterThan(0)
    expect(stats.spans.retried).toBeGreaterThan(0)
    expect(stats.spans.lastError).toContain('503')
  })
})
