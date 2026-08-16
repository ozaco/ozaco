import { Tracer } from 'server:core'
import { sleep } from 'std:effect'
import { install } from 'std:plugin'

import { describe, expect, it } from 'bun:test'

import { DefaultTracer, MemoryExporter } from 'server:plugin/trace'
import { BunIO } from 'std:io/impl/bun'

import { runScoped } from '../helpers'

describe('default tracer', () => {
  it('startSpan mints OTel-shaped ids and links parents', async () => {
    const { root, child } = await runScoped(function* () {
      yield* install(BunIO)
      yield* install(DefaultTracer)

      const rootSpan = yield* Tracer.actions.startSpan('root')
      const childSpan = yield* Tracer.actions.startSpan('child', { parent: rootSpan.context })

      return { root: rootSpan.context, child: childSpan.context }
    })

    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/u)
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/u)
    expect(root.parentSpanId).toBeUndefined()
    expect(child.traceId).toBe(root.traceId)
    expect(child.parentSpanId).toBe(root.spanId)
    expect(child.spanId).not.toBe(root.spanId)
  })

  it('end() folds the mutable span into a snapshot delivered to the exporter', async () => {
    const snapshots = await runScoped(function* () {
      yield* install(BunIO)
      yield* install(MemoryExporter)
      yield* install(DefaultTracer)

      const span = yield* Tracer.actions.startSpan('work', {
        kind: 'server',
        attributes: { seed: 'x' },
      })

      span.setAttribute('answer', 42)
      span.recordException('boom')
      span.setStatus('error', 'it broke')
      span.end()
      span.end() // idempotent — must not double-deliver

      yield* DefaultTracer.actions.flush()

      return yield* MemoryExporter.actions.drain()
    })

    expect(snapshots).toHaveLength(1)

    const snapshot = snapshots[0]!

    expect(snapshot.name).toBe('work')
    expect(snapshot.kind).toBe('server')
    expect(snapshot.status).toBe('error')
    expect(snapshot.attributes.seed).toBe('x')
    expect(snapshot.attributes.answer).toBe(42)
    expect(snapshot.attributes['otel.status_description']).toBe('it broke')
    expect(snapshot.events).toHaveLength(1)
    expect(snapshot.events[0]!.message).toBe('boom')
    expect(snapshot.endMs).toBeGreaterThanOrEqual(snapshot.startMs)
    expect(snapshot.context.spanId).toMatch(/^[0-9a-f]{16}$/u)
  })

  it('recent() keeps a bounded ring of the latest snapshots', async () => {
    const names = await runScoped(function* () {
      yield* install(BunIO)
      yield* install(DefaultTracer, { keep: 2 })

      for (const name of ['a', 'b', 'c']) {
        const span = yield* Tracer.actions.startSpan(name)

        span.end()
      }

      const recent = yield* DefaultTracer.actions.recent()

      return recent.map(snapshot => snapshot.name)
    })

    expect(names).toEqual(['b', 'c'])
  })

  it('a full batch wakes the pump without an explicit flush', async () => {
    const count = await runScoped(function* () {
      yield* install(BunIO)
      yield* install(MemoryExporter)
      yield* install(DefaultTracer, { batchSize: 2, flushIntervalMs: 60_000 })

      for (const name of ['one', 'two']) {
        const span = yield* Tracer.actions.startSpan(name)

        span.end()
      }

      yield* sleep(50)

      const drained = yield* MemoryExporter.actions.drain()

      return drained.length
    })

    expect(count).toBe(2)
  })

  it('flush() delivers every buffered snapshot in order', async () => {
    const names = await runScoped(function* () {
      yield* install(BunIO)
      yield* install(MemoryExporter)
      yield* install(DefaultTracer)

      for (const name of ['first', 'second', 'third']) {
        const span = yield* Tracer.actions.startSpan(name)

        span.end()
      }

      yield* DefaultTracer.actions.flush()

      const drained = yield* MemoryExporter.actions.drain()

      return drained.map(snapshot => snapshot.name)
    })

    expect(names).toEqual(['first', 'second', 'third'])
  })

  it('is zero-cost without an exporter: flush hits the no-op defaults', async () => {
    const recent = await runScoped(function* () {
      yield* install(BunIO)
      yield* install(DefaultTracer)

      const span = yield* Tracer.actions.startSpan('lonely')

      span.end()

      yield* DefaultTracer.actions.flush()

      return yield* DefaultTracer.actions.recent()
    })

    expect(recent).toHaveLength(1)
    expect(recent[0]!.name).toBe('lonely')
  })
})
