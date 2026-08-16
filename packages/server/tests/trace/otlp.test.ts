import { Broker, TraceExporter, Tracer, defineAction, defineService } from 'server:core'
import type { TracerDef } from 'server:core'
import { attempt } from 'std:effect'
import { FetchClient } from 'std:fetch'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { DefaultTracer, TracingPolicy } from 'server:plugin/trace'
import { OtlpErrors, OtlpExporter } from 'server:plugin/trace/otlp'
import type { Otlp } from 'server:plugin/trace/otlp'
import { BunIO } from 'std:io/impl/bun'

import { bootstrap } from '../core/helpers'
import { runScoped } from '../helpers'

const snapshotFixture = (): TracerDef.SpanSnapshot => ({
  name: 'manual',
  kind: 'internal',
  context: { traceId: 'ab'.repeat(16), spanId: 'cd'.repeat(8) },
  startMs: Date.now(),
  endMs: Date.now(),
  status: 'ok',
  attributes: {},
  events: [],
})

describe('otlp exporter', () => {
  it('POSTs the OTLP/HTTP JSON mapping with nano-string times', async () => {
    const captured: unknown[] = []
    const server = Bun.serve({
      port: 0,
      fetch: async request => {
        captured.push(await request.json())

        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      },
    })

    let parentContext: { traceId: string; spanId: string }

    try {
      parentContext = await runScoped(function* () {
        yield* install(BunIO)
        yield* install(FetchClient)
        yield* install(OtlpExporter, {
          endpoint: `http://localhost:${server.port}`,
          serviceName: 'test-svc',
        })
        yield* install(DefaultTracer)

        const parent = yield* Tracer.actions.startSpan('parent', {
          kind: 'client',
          attributes: { count: 3, flag: true, label: 'x' },
        })
        const child = yield* Tracer.actions.startSpan('child', { parent: parent.context })

        child.end()
        parent.recordException('boom')
        parent.setStatus('error', 'broke')
        parent.end()

        yield* DefaultTracer.actions.flush()

        return { traceId: parent.context.traceId, spanId: parent.context.spanId }
      })
    } finally {
      server.stop(true)
    }

    expect(captured).toHaveLength(1)

    const payload = captured[0] as Otlp.ExportRequest
    const resourceSpans = payload.resourceSpans[0]!

    expect(resourceSpans.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'test-svc' } },
    ])

    const scopeSpans = resourceSpans.scopeSpans[0]!

    expect(scopeSpans.scope.name).toBe('ozaco-server')
    expect(scopeSpans.spans).toHaveLength(2)

    const child = scopeSpans.spans.find(span => span.name === 'child')!
    const parent = scopeSpans.spans.find(span => span.name === 'parent')!

    expect(child.traceId).toBe(parentContext.traceId)
    expect(child.parentSpanId).toBe(parentContext.spanId)
    expect(child.kind).toBe(1)
    expect(child.status).toEqual({ code: 1 })

    expect(parent.traceId).toBe(parentContext.traceId)
    expect(parent.spanId).toBe(parentContext.spanId)
    expect(parent.parentSpanId).toBeUndefined()
    expect(parent.kind).toBe(3)
    expect(parent.status).toEqual({ code: 2, message: 'broke' })
    expect(parent.startTimeUnixNano).toMatch(/^\d{18,20}$/u)
    expect(parent.endTimeUnixNano).toMatch(/^\d{18,20}$/u)
    expect(BigInt(parent.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(parent.startTimeUnixNano))
    expect(parent.events).toHaveLength(1)
    expect(parent.events[0]!.name).toBe('boom')
    expect(parent.events[0]!.timeUnixNano).toMatch(/^\d{18,20}$/u)
    expect(parent.attributes).toContainEqual({ key: 'count', value: { intValue: '3' } })
    expect(parent.attributes).toContainEqual({ key: 'flag', value: { boolValue: true } })
    expect(parent.attributes).toContainEqual({ key: 'label', value: { stringValue: 'x' } })
  })

  it('fails with the otlp export tag on a non-2xx response', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('nope', { status: 500 }),
    })

    let result: { failed: boolean; error: string | undefined }

    try {
      result = await runScoped(function* () {
        yield* install(BunIO)
        yield* install(FetchClient)
        yield* install(OtlpExporter, { endpoint: `http://localhost:${server.port}` })

        const outcome = yield* attempt(() => TraceExporter.actions.export([snapshotFixture()]))

        return {
          failed: isFailure(outcome),
          error: isFailure(outcome) ? String(outcome.error) : undefined,
        }
      })
    } finally {
      server.stop(true)
    }

    expect(result.failed).toBe(true)
    expect(result.error).toBe(OtlpErrors.Export)
  })

  it('a dead collector never breaks the app — the tracer isolates export failures', async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
    const deadPort = probe.port

    probe.stop(true)

    const values = await runScoped(function* () {
      const service = defineService({
        name: 'svc',
        actions: {
          ok: defineAction(function* () {
            return 7
          }),
        },
      })

      yield* bootstrap()
      yield* install(FetchClient)
      yield* install(OtlpExporter, {
        endpoint: `http://localhost:${deadPort}`,
        timeoutMs: 500,
      })
      yield* install(DefaultTracer)
      yield* install(TracingPolicy)
      yield* Broker.actions.register(service)

      const first = yield* Broker.actions.call(service, 'ok', undefined)

      // the export inside fails against the closed port — flush must swallow it
      yield* DefaultTracer.actions.flush()

      const second = yield* Broker.actions.call(service, 'ok', undefined)

      return [first, second]
    })

    expect(values).toEqual([7, 7])
  })
})
