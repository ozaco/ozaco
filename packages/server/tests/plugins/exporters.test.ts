/**
 * `ObserveExporter`: destinations run SIDE BY SIDE — the kernel fans every event out to all
 * installs (nested ones included), starts them with the node and flushes them at stop; they
 * work with or without the `ObservePlugin` store.
 */
import type { ObserveDef } from 'server:core'
import { createServer, ObserveExporter } from 'server:core'
import { StdoutExporter } from 'server:plugins'
import { attempt, run, sleep } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { OtlpExporter } from 'server:plugins/observe/otlp'

import { storage, todos } from '../helpers'

/** A destination of one's own: every event lands in an array, flushes are counted. */
const memoryExporter = () => {
  const seen: ObserveDef.Event[] = []
  const lifecycle = { started: 0, flushed: 0 }
  const Impl = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
    name: 'test-observe-memory',
    version: '0.0.0',
    *setup() {
      return { exporter: 'memory' }
    },
  })
  const plugin = Impl.build({
    *export(event: ObserveDef.Event) {
      seen.push(event)
    },
    *start() {
      lifecycle.started += 1
    },
    *flush() {
      lifecycle.flushed += 1
    },
  })
  return { plugin, seen, lifecycle }
}

describe('observe exporters', () => {
  it('several exporters see every event, start with the node and flush at stop — no store needed', async () => {
    const memory = memoryExporter()
    const lines: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    const received: string[] = []
    const fakeFetch = ((url: string | URL) => {
      received.push(String(url))
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as typeof fetch
    try {
      unwrap(
        await run(function* () {
          yield* storage()
          const server = yield* createServer({
            services: [todos],
            plugins: [
              memory.plugin,
              StdoutExporter,
              OtlpExporter.use({
                url: 'http://collector:4318',
                fetch: fakeFetch,
                batch: { waitMs: 10 },
              }),
            ],
          })
          yield* server.start()
          expect(memory.lifecycle.started).toBe(1)
          yield* server.call(todos, 'create', { title: 'shipped' })
          yield* attempt(server.call(todos, 'explode', { code: 'x.y' }))
          yield* sleep(60)
          // the same events reached all three
          expect(memory.seen.some(event => event.t === 'span')).toBe(true)
          expect(memory.seen.some(event => event.t === 'failure')).toBe(true)
          expect(lines.some(line => line.includes('todos.create') && line.includes('ok'))).toBe(
            true,
          )
          expect(lines.some(line => line.includes('✗ x.y'))).toBe(true)
          expect(received.some(url => url.endsWith('/v1/traces'))).toBe(true)
          yield* server.stop()
          expect(memory.lifecycle.flushed).toBe(1)
        }),
      )
    } finally {
      console.log = original
    }
  })

  it('an exporter installed INSIDE another one is fanned out to directly (no relay)', async () => {
    const inner = memoryExporter()
    const Outer = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
      name: 'test-observe-outer',
      version: '0.0.0',
      *setup() {
        yield* inner.plugin.use()
        return { exporter: 'outer' }
      },
    }).build({
      *export() {},
      *start() {},
      *flush() {},
    })
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [todos], plugins: [Outer] })
        yield* server.start()
        yield* server.call(todos, 'create', { title: 'nested' })
        yield* sleep(20)
        expect(inner.lifecycle.started).toBe(1)
        expect(inner.seen.length).toBeGreaterThan(0)
        yield* server.stop()
        expect(inner.lifecycle.flushed).toBe(1)
      }),
    )
  })

  it('with no exporter installed nothing is captured for one', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [todos] })
        yield* server.start()
        expect((server as AnyType).exporting ?? false).toBe(false)
        yield* server.stop()
      }),
    )
  })
})
