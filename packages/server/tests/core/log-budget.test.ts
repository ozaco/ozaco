/**
 * SINK PARITY for log records (design §9, decisions log "Sink parity enforcement"): the kernel
 * cuts a record's attributes to the log budget (≤ 96 attributes, ≤ 48 KiB — the largest values
 * first, unprotected keys before the exception / event keys, counted into `droppedAttributes`)
 * ONCE, before the fan-out. The observe hook (the store), the kernel's `observe` stream, a custom
 * exporter, stdout, OTLP/JSON and OpenObserve (OTLP/protobuf) all hold the IDENTICAL record — no
 * sink keeps more, none cuts again.
 */
import type { ObserveDef, ServerDef } from 'server:core'
import { action, createServer, ObserveExporter, Server, service } from 'server:core'
import { StdoutExporter } from 'server:plugins'
import { run, useContext } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { emitLog } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { OpenObserveExporter } from 'server:plugins/observe/openobserve'
import { OtlpExporter } from 'server:plugins/observe/otlp'

import { storage } from '../helpers'
import { attrsOf, fakeCollector } from '../plugins/otlp-wire'

const BLOB = 'x'.repeat(2000)

/** 1 exception key + 150 small fields: over the COUNT budget (std itself keeps 128). */
const many = (): Record<string, TraceDef.AttrValue> => {
  const attributes: Record<string, TraceDef.AttrValue> = { 'exception.type': 'x.y' }

  for (let index = 0; index < 150; index += 1) {
    attributes[`ozaco.field_${index}`] = index
  }

  return attributes
}

/** 30 values of ~2 KB (std's per-value cap) between two small ones: over the BYTE budget. */
const huge = (): Record<string, TraceDef.AttrValue> => {
  const attributes: Record<string, TraceDef.AttrValue> = { 'exception.type': 'x.y' }

  for (let index = 0; index < 30; index += 1) {
    attributes[`ozaco.blob_${String(index).padStart(2, '0')}`] = BLOB
  }

  attributes['ozaco.small'] = 'ok'

  return attributes
}

const wide = service('wide', {
  write: action.mutation({}, function* () {
    yield* emitLog({ body: 'many fields', severityNumber: 9, attributes: many() })
    yield* emitLog({ body: 'huge fields', severityNumber: 9, attributes: huge() })
    return 'ok'
  }),
})

/** A sink of one's own: every event it is handed. */
const memoryExporter = () => {
  const seen: ObserveDef.Event[] = []
  const plugin = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
    name: 'test/log-budget-memory',
    version: '0.0.0',
    *setup() {
      return { exporter: 'memory' }
    },
  }).build({
    *export(event: ObserveDef.Event) {
      seen.push(event)
    },
    *start() {},
    *flush() {},
  })

  return { plugin, seen }
}

/** The store's path: an `observe` hook. */
const hookSpy = () => {
  const seen: ObserveDef.Event[] = []
  const plugin = definePlugin<ServerDef.PluginContext, []>({
    name: 'test/log-budget-hook',
    version: '0',
    description: 'captures observe events',
    *setup() {
      const hooks: ServerDef.Hooks = {
        name: 'hook-spy',
        *observe(event) {
          seen.push(event)
        },
      }
      return { hooks }
    },
  }).build()

  return { plugin, seen }
}

const logOf = (events: readonly ObserveDef.Event[], body: string): TraceDef.LogData => {
  const found = events.flatMap(event =>
    event.t === 'log' && event.log.body === body ? [event.log] : [],
  )
  expect(found).toHaveLength(1)
  return found[0]!
}

describe('log attribute budget — once, in the kernel, before every sink', () => {
  it('store, observe stream, custom exporter, stdout, OTLP/JSON and OpenObserve hold the same cut record', async () => {
    const hook = hookSpy()
    const memory = memoryExporter()
    const json = fakeCollector()
    const protobuf = fakeCollector()
    const stream: ObserveDef.Event[] = []
    const lines: string[] = []
    const original = console.log

    console.log = (...args: unknown[]) => {
      lines.push(...args.map(String).join(' ').split('\n'))
    }

    try {
      unwrap(
        await run(function* () {
          yield* storage()
          const server = yield* createServer({
            services: [wide],
            name: 'budget',
            plugins: [
              hook.plugin.use(),
              memory.plugin,
              StdoutExporter,
              OtlpExporter.use({
                url: 'http://collector:4318',
                encoding: 'json',
                fetch: json.fetch,
                batch: { waitMs: 10 },
                metrics: false,
              }),
              OpenObserveExporter.use({
                url: 'http://openobserve:5080',
                auth: { token: 't' },
                fetch: protobuf.fetch,
                batch: { waitMs: 10 },
                metrics: false,
              }),
            ],
          })
          const kernel = yield* useContext(Server)
          kernel.events.on('observe', event => {
            stream.push(event)
          })
          yield* server.start()
          yield* server.call(wide, 'write', {})
          yield* server.stop()
        }),
      )
    } finally {
      console.log = original
    }

    // the count budget: 96 kept (the exception key spared), everything else counted as dropped
    const counted = logOf(hook.seen, 'many fields')
    const countedKeys = Object.keys(counted.attributes)
    expect(countedKeys).toHaveLength(96)
    expect(countedKeys[0]).toBe('exception.type')
    expect(countedKeys.at(-1)).toBe('ozaco.field_94')
    expect(counted.droppedAttributes).toBe(151 - 96)

    // the byte budget: the largest values go first until ≤ 48 KiB — the small ones stay
    const sized = logOf(hook.seen, 'huge fields')
    expect(Object.keys(sized.attributes)).toEqual([
      'exception.type',
      ...Array.from({ length: 24 }, (_, at) => `ozaco.blob_${String(at + 6).padStart(2, '0')}`),
      'ozaco.small',
    ])
    expect(sized.droppedAttributes).toBe(6)

    for (const body of ['many fields', 'huge fields']) {
      const reference = logOf(hook.seen, body)

      // in-process sinks: the very same record
      expect(logOf(memory.seen, body)).toEqual(reference)
      expect(logOf(stream, body)).toEqual(reference)

      // the OTLP legs (JSON and protobuf) carry exactly its attributes and dropped count
      for (const collector of [json, protobuf]) {
        const shipped = collector
          .logs()
          .filter((record: AnyType) => record.body.stringValue === body)
        expect(shipped).toHaveLength(1)
        expect(attrsOf(shipped[0])).toEqual(reference.attributes as Record<string, AnyType>)
        expect(shipped[0].droppedAttributesCount).toBe(reference.droppedAttributes)
      }

      // stdout prints the same attributes — no more
      const line = lines.find(entry => entry.includes(` ${body} `))!
      expect(line).toBeDefined()
      const printed = [...line.matchAll(/ (ozaco\.[a-z_0-9]+|exception\.type)=/gu)].map(
        match => match[1],
      )
      expect(printed).toEqual(Object.keys(reference.attributes))
    }
  })
})
