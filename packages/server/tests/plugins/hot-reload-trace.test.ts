/**
 * `HotReload` telemetry (design §7): every generation is a ROOT span `hot-reload` of its own
 * (`ozaco.reload.generation`, `ozaco.reload.triggers`, `ozaco.reload.services.*`) LINKING the
 * previous generation (`reload.previous`), with the steps as children (`hot-reload.bundle`,
 * `hot-reload.import`, `server.reload`). A failed reload is recorded ONCE (WARN — the node keeps
 * serving) with its whole chain — what the user's code threw (its fold) as the cause — and logged
 * through the std Logger as the Failure itself; a failing `onReload` / `onError` hook is logged,
 * never swallowed. Seen through an in-memory std:trace `Tracer`.
 */
import type { ServiceDef } from 'server:core'
import { action, createServer, refs, service } from 'server:core'
import { HotReload, HotReloadErrors } from 'server:plugins'
import type { Operation } from 'std:effect'
import { attempt, run, sleep } from 'std:effect'
import { IO } from 'std:io'
import type { LoggerDef } from 'std:logger'
import { DefaultLogger, LoggerTransport, LogLevel } from 'std:logger'
import type { Result } from 'std:result'
import { fail, isFailure, ResultErrors, unwrap } from 'std:result'
import type { TraceDef } from 'std:trace'
import { enableTracing, Tracer } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import pkg from '../../package.json'
import { storage } from '../helpers'

// the fs.watch fallback answers within milliseconds; a Watchman daemon may take longer to settle
process.env['STD_WATCHMAN'] = 'off'

const SCOPE = '@ozaco/server/hot-reload'

let installs = 0

/** An in-memory std:trace `Tracer` installed around the server: every span and log record. */
const memoryTracer = () => {
  installs += 1
  const spans: TraceDef.SpanData[] = []
  const logs: TraceDef.LogData[] = []

  const plugin = Tracer.implement({
    name: `test/hot-reload-tracer-${installs}`,
    version: '1.0.0',
    *setup() {
      yield* enableTracing()
      return {}
    },
  }).build({
    *export(data: TraceDef.SpanData) {
      spans.push(data)
    },
    *emit(log: TraceDef.LogData) {
      logs.push(log)
    },
  })

  const named = (name: string): TraceDef.SpanData[] => spans.filter(data => data.name === name)
  const childrenOf = (parent: TraceDef.SpanData): TraceDef.SpanData[] =>
    spans.filter(data => data.parent?.spanId === parent.context.spanId)
  const exceptions = (): TraceDef.LogData[] =>
    logs.filter(log => log.attributes['exception.type'] !== undefined)

  return { plugin, spans, logs, named, childrenOf, exceptions }
}

/** Every std Logger entry (the HotReload lines among them). */
const captureLogger = () => {
  installs += 1
  const entries: LoggerDef.Entry[] = []

  const plugin = LoggerTransport.implement({
    name: `test/hot-reload-capture-${installs}`,
    version: '1.0.0',
    *setup() {
      return { name: 'capture', level: LogLevel.trace }
    },
  }).build({
    *write(entry: LoggerDef.Entry) {
      entries.push(entry)
    },
    *flush() {},
    *close() {},
  })

  return { plugin, entries }
}

type Hot = ServiceDef.Service<'hot', { greet: ServiceDef.Action<undefined, z.ZodString> }>

const hot = (greeting: string) =>
  service('hot', {
    greet: action.query({ output: z.string() }, function* () {
      return greeting
    }),
  })

/** A throwaway declarations module under the package (the `server:*` aliases resolve there). */
function* scaffold(
  name: string,
  body: readonly string[],
): Operation<{ dir: string; entry: string }> {
  const dir = yield* IO.actions.join(import.meta.dirname, '..', '..', '.ozaco', 'hot-reload', name)
  yield* IO.actions.emptyDir(dir)
  const entry = yield* IO.actions.join(dir, 'services.ts')
  yield* writeEntry(entry, body)
  return { dir, entry }
}

function* writeEntry(entry: string, body: readonly string[]): Operation<void> {
  yield* IO.actions.write(
    entry,
    [
      `import { action, service } from 'server:core'`,
      `import { z } from 'zod'`,
      ``,
      ...body,
      ``,
    ].join('\n'),
  )
}

const GOOD = [
  `export const services = [`,
  `  service('hot', { greet: action.query({ output: z.string() }, function* () { return 'hi' }) }),`,
  `]`,
]

describe('plugins — hot reload telemetry', () => {
  it('one ROOT span per generation, linked to the previous one, the steps as children', async () => {
    const tracer = memoryTracer()
    let greeting = 'one'

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()
        const server = yield* createServer({
          services: [],
          plugins: [
            HotReload.use({
              entry: 'unused.ts',
              *load() {
                return [hot(greeting)]
              },
            }),
          ],
        })
        const greet = refs<Hot>('hot').greet

        yield* HotReload.actions.reload()
        greeting = 'two'
        yield* HotReload.actions.reload()
        expect(yield* server.call(greet)).toBe('two')
      }),
    )

    const [first, second] = tracer.named('hot-reload')
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    // a ROOT of its own each time, never under whatever called it
    for (const root of [first!, second!]) {
      expect(root.parent).toBeNull()
      expect(root.kind).toBe('internal')
      expect(root.scope.name).toBe(SCOPE)
      expect(root.status.code).toBe('unset')
      // a manual reload names no changed paths
      expect(root.attributes['ozaco.reload.triggers']).toBeUndefined()
    }

    expect(first!.context.traceId).not.toBe(second!.context.traceId)
    expect(first!.attributes).toMatchObject({
      'ozaco.reload.generation': 1,
      'ozaco.reload.services.added': ['hot'],
    })
    expect(second!.attributes).toMatchObject({
      'ozaco.reload.generation': 2,
      'ozaco.reload.services.replaced': ['hot'],
    })
    // an empty list is no attribute at all: a sink dropping empty arrays (OpenObserve) holds
    // the same data as every other
    expect(first!.attributes).not.toContainAnyKeys([
      'ozaco.reload.services.removed',
      'ozaco.reload.services.replaced',
    ])
    expect(second!.attributes).not.toContainAnyKeys([
      'ozaco.reload.services.added',
      'ozaco.reload.services.removed',
    ])

    // the first generation links nothing, the second LINKS the first
    expect(first!.links).toEqual([])
    expect(second!.links).toHaveLength(1)
    expect(second!.links[0]!.context.spanId).toBe(first!.context.spanId)
    expect(second!.links[0]!.context.traceId).toBe(first!.context.traceId)
    expect(second!.links[0]!.attributes).toEqual({ 'ozaco.link.reason': 'reload.previous' })

    // the steps: the (custom) import, then the swap — children of their generation
    for (const root of [first!, second!]) {
      const steps = tracer.childrenOf(root)
      expect(steps.map(data => data.name).toSorted()).toEqual([
        'hot-reload.import',
        'server.reload',
      ])
      for (const child of steps) {
        expect(child.scope.name).toBe(SCOPE)
        expect(child.context.traceId).toBe(root.context.traceId)
      }
    }

    // no attribute key breaks the key rule, no event name is longer than Grafana shows
    for (const data of tracer.named('hot-reload')) {
      for (const key of Object.keys(data.attributes)) {
        expect(key).toMatch(/^ozaco\.reload(?:\.[a-z0-9_]+)+$/u)
      }
    }
  })

  it('a failed reload: ONE WARN record with its chain, logged as the Failure, hooks never swallowed', async () => {
    const tracer = memoryTracer()
    const logger = captureLogger()
    let broken = false
    const seen: Result.Failure<unknown>[] = []

    const outcome = await run(function* () {
      yield* storage()
      yield* DefaultLogger.use({ level: LogLevel.info })
      yield* logger.plugin.use()
      yield* tracer.plugin.use()
      yield* createServer({
        services: [],
        plugins: [
          HotReload.use({
            entry: 'unused.ts',
            *load() {
              if (broken) {
                // the user's own code throws while its declarations load
                throw new TypeError('greeting is not a function')
              }
              return [hot('hi')]
            },
            *onReload() {
              return yield* fail('test.on-reload', 'the onReload hook broke')
            },
            *onError(failure) {
              seen.push(failure)
              throw new RangeError('the onError hook broke too')
            },
          }),
        ],
      })

      // the onReload hook fails: the reload still succeeds
      const report = yield* HotReload.actions.reload()
      expect(report.added).toEqual(['hot'])

      broken = true
      const failed = yield* attempt(HotReload.actions.reload())
      expect(isFailure(failed)).toBe(true)
      const status = yield* HotReload.actions.status()
      return { failed: failed as Result.Failure<unknown>, lastError: status.lastError }
    })

    const { failed, lastError } = unwrap(outcome)

    // the manual reload raises what failed (the thrown TypeError, `asFailure`'s fold: tagged
    // `std:result.unknown`, the Error its `raw`), labelled by the plugin runtime on its way out
    // of `reload`; the status carries it as ONE line, rendered where the reload failed — before
    // those labels
    expect(failed.error).toBe(ResultErrors.Unknown)
    expect(failed.message).toBe('TypeError: greeting is not a function')
    expect(failed.raw).toBeInstanceOf(TypeError)
    expect(failed.causes).toEqual([
      'reload',
      `server-hot-reload@${pkg.version}`,
      'dispatch',
      `server-hot-reload@${pkg.version}`,
    ])
    expect(lastError).toBe(`${ResultErrors.Unknown}: TypeError: greeting is not a function`)
    expect(seen).toEqual([failed])

    const [ok, bad] = tracer.named('hot-reload')
    expect(ok!.status.code).toBe('unset')
    expect(bad!.status.code).toBe('error')
    expect(bad!.attributes['error.type']).toBe('server.internal')
    expect(bad!.links[0]!.context.spanId).toBe(ok!.context.spanId)

    // the import step failed; no swap happened
    const steps = tracer.childrenOf(bad!)
    expect(steps.map(data => data.name)).toEqual(['hot-reload.import'])
    expect(steps[0]!.attributes['error.type']).toBe('server.internal')

    // exactly ONE exception record per failure: the reload (WARN, the node keeps serving), the
    // onReload hook (WARN), the onError hook (WARN) — each on its generation's span
    const records = tracer.exceptions()
    // a thrown value's record is typed `std:result.unknown`, told apart by its message
    const thrown = (text: string) =>
      records.filter(
        log =>
          log.attributes['exception.type'] === ResultErrors.Unknown &&
          log.attributes['exception.message'] === text,
      )
    const reload = thrown('TypeError: greeting is not a function')
    expect(reload).toHaveLength(1)
    expect(reload[0]!.severityNumber).toBe(13)
    expect(reload[0]!.context?.spanId).toBe(bad!.context.spanId)
    expect(reload[0]!.body).toContain('TypeError: greeting is not a function')

    const onReload = records.filter(log => log.attributes['exception.type'] === 'test.on-reload')
    expect(onReload).toHaveLength(1)
    expect(onReload[0]!.severityNumber).toBe(13)
    expect(onReload[0]!.context?.spanId).toBe(ok!.context.spanId)

    const onError = thrown('RangeError: the onError hook broke too')
    expect(onError).toHaveLength(1)
    expect(onError[0]!.context?.spanId).toBe(bad!.context.spanId)
    expect(records).toHaveLength(3)

    // the Logger got the Failure ITSELF (never its pieces), under the plugin's logger binding —
    // and its line is the record of the same span, scoped to the plugin
    const warned = logger.entries.find(entry => entry.msg.startsWith('reload #2 failed'))
    expect(warned).toBeDefined()
    expect(warned!.failures).toEqual([failed])
    expect(warned!.bindings['logger']).toBe(SCOPE)
    expect(warned!.trace?.spanId).toBe(bad!.context.spanId)

    const hookLines = logger.entries.filter(entry => entry.msg.endsWith('hook failed'))
    expect(hookLines.map(entry => entry.msg).toSorted()).toEqual([
      'the onError hook failed',
      'the onReload hook failed',
    ])
    // each failure reaches the console ONCE: the plugin's own line — the server does not forward
    // the record of a failure a line printed a second time
    expect(logger.entries.filter(entry => entry.level >= LogLevel.warn)).toHaveLength(3)

    const line = tracer.logs.find(log => log.body.startsWith('reload #2 failed'))
    expect(line?.scope.name).toBe(SCOPE)
    expect(line?.severityNumber).toBe(13)
    expect(line?.context?.spanId).toBe(bad!.context.spanId)
    expect(line?.attributes['ozaco.reload.generation']).toBe(2)

    const info = logger.entries.find(entry => entry.msg.startsWith('reload #1 in'))
    expect(info?.data).toMatchObject({
      'ozaco.reload.generation': 1,
      'ozaco.reload.services.added': ['hot'],
    })
  })

  it('bundled on Bun: the bundle and import are steps — a throwing module keeps what it threw', async () => {
    const tracer = memoryTracer()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()
        const files = yield* scaffold('trace-steps', GOOD)
        const server = yield* createServer({
          services: [],
          plugins: [HotReload.use({ entry: files.entry, watch: [files.dir] })],
        })
        yield* HotReload.actions.reload()
        expect(yield* server.call(refs<Hot>('hot').greet)).toBe('hi')

        // evaluating the bundle throws: the user's TypeError (its fold) as the CAUSE
        yield* writeEntry(files.entry, [
          ...GOOD,
          `const broken: any = undefined`,
          `broken.greeting()`,
        ])
        const thrown = yield* attempt(HotReload.actions.reload())
        expect(isFailure(thrown)).toBe(true)
        const evaluated = thrown as Result.Failure<unknown>
        expect(evaluated.error).toBe(HotReloadErrors.Load)
        expect(evaluated.message).toStartWith('could not evaluate ')
        // the nested cause: the fold of the user's TypeError, ONE level under the load failure —
        // the Error itself its `raw`
        const inner = evaluated.causes.find(isFailure)!
        expect(inner.error).toBe(ResultErrors.Unknown)
        expect(inner.message).toBe(
          "TypeError: undefined is not an object (evaluating 'broken.greeting')",
        )
        expect(inner.raw).toBeInstanceOf(TypeError)
        expect(inner.causes.filter(isFailure)).toEqual([])
        // …its stack pointing at the user's own file, not at the temp bundle it ran from
        expect((inner.raw as Error).stack).toContain(`${files.entry}:`)

        // a syntax error never gets past the bundler: its message, at the source position
        yield* writeEntry(files.entry, [`export const services = = []`])
        const syntax = yield* attempt(HotReload.actions.reload())
        const bundled = syntax as Result.Failure<unknown>
        expect(bundled.error).toBe(HotReloadErrors.Load)
        const said = bundled.causes.find(isFailure)!
        expect(said.error).toBe(HotReloadErrors.Build)
        expect(said.message).toBe('Unexpected =')
        expect(said.causes).toHaveLength(1)
        expect(said.causes[0]).toStartWith(`${files.entry}:`)

        // the good declarations kept serving through both
        expect(yield* server.call(refs<Hot>('hot').greet)).toBe('hi')
        yield* IO.actions.rm(files.dir, { recursive: true, force: true })
      }),
    )

    const [good, threw, unparsable] = tracer.named('hot-reload')
    expect(tracer.childrenOf(good!).map(data => data.name)).toEqual([
      'hot-reload.bundle',
      'hot-reload.import',
      'server.reload',
    ])

    const threwSteps = tracer.childrenOf(threw!)
    expect(threwSteps.map(data => [data.name, data.status.code])).toEqual([
      ['hot-reload.bundle', 'unset'],
      ['hot-reload.import', 'error'],
    ])
    expect(threwSteps[1]!.attributes['error.type']).toBe(HotReloadErrors.Load)

    const unparsableSteps = tracer.childrenOf(unparsable!)
    expect(unparsableSteps.map(data => [data.name, data.status.code])).toEqual([
      ['hot-reload.bundle', 'error'],
    ])

    // one WARN record per failed generation, its chain down to the user's error
    const records = tracer.exceptions()
    expect(records).toHaveLength(2)
    expect(records.map(log => log.severityNumber)).toEqual([13, 13])
    expect(records[0]!.attributes['ozaco.failure.chain']).toHaveLength(2)
    expect((records[0]!.attributes['ozaco.failure.chain'] as string[])[1]).toStartWith(
      `${ResultErrors.Unknown}: TypeError`,
    )
  })

  it('a save becomes a generation whose triggers are the changed paths', async () => {
    const tracer = memoryTracer()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()
        const files = yield* scaffold('trace-watch', GOOD)
        const server = yield* createServer({
          services: [],
          plugins: [HotReload.use({ entry: files.entry, watch: [files.dir], debounceMs: 30 })],
        })
        yield* server.start()
        yield* HotReload.actions.reload()

        // let the watcher settle, then save
        yield* sleep(100)
        yield* writeEntry(
          files.entry,
          GOOD.map(text => text.replace("'hi'", "'saved'")),
        )

        const deadline = Date.now() + 5000
        let answer = ''
        while (answer !== 'saved' && Date.now() < deadline) {
          yield* sleep(50)
          answer = yield* server.call(refs<Hot>('hot').greet)
        }

        expect(answer).toBe('saved')
        yield* server.stop()
        yield* IO.actions.rm(files.dir, { recursive: true, force: true })
      }),
    )

    // the generation that brought the save in (a late event of the scaffold's own writes may
    // have made one more before it)
    const generations = tracer.named('hot-reload')
    const saved = generations.at(-1)!
    expect(generations.length).toBeGreaterThanOrEqual(2)
    const triggers = saved.attributes['ozaco.reload.triggers'] as readonly string[]
    expect(triggers.some(path => path.endsWith('/trace-watch/services.ts'))).toBe(true)

    // every generation links the one before it
    for (const [at, generation] of generations.entries()) {
      if (at > 0) {
        expect(generation.links[0]!.context.spanId).toBe(generations[at - 1]!.context.spanId)
      }
    }
  })
})
