import { attempt, fork, sleep } from 'std:effect'
import type { Task } from 'std:effect'
import { fail } from 'std:result'
import { emitLog, event, span } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { traced, tracedResult } from './helpers'

describe("record: 'errors' (a local root option)", () => {
  it('a clean local trace is dropped: no spans, no log records', async () => {
    const { tracer } = await traced(() =>
      span('GET /_health', { record: 'errors', kind: 'server' }, function* () {
        yield* span('db', function* () {})
        yield* event('ozaco.probe')
        yield* emitLog({ body: 'fine', severityNumber: 9 })
      }),
    )

    expect(tracer.spans).toEqual([])
    expect(tracer.logs).toEqual([])
  })

  it('a recorded failure keeps the whole local trace, logs included', async () => {
    const { tracer } = await tracedResult(() =>
      span('GET /_observe/api/traces', { record: 'errors', kind: 'server' }, function* () {
        yield* event('ozaco.probe')
        yield* span('db', function* () {})
        return yield* span('query', () => fail('db.down', 'store gone'))
      }),
    )

    expect(tracer.names()).toBe('db, query, GET /_observe/api/traces')
    expect(tracer.logs.map(log => log.eventName)).toEqual(['ozaco.probe', 'exception'])
  })

  it('a handled failure counts too', async () => {
    const { tracer } = await traced(() =>
      span('poll', { record: 'errors' }, function* () {
        yield* attempt(() => span('probe', () => fail('app.flaky')))
      }),
    )

    expect(tracer.names()).toBe('probe, poll')
    expect(tracer.exceptions()).toHaveLength(1)
  })

  it('a span the code marked failed keeps it; so does an ERROR log line', async () => {
    const { tracer: marked } = await traced(() =>
      span('marked', { record: 'errors' }, () =>
        span('inner', function* (inner) {
          inner.setStatus({ code: 'error', message: '503 from upstream' })
        }),
      ),
    )
    expect(marked.names()).toBe('inner, marked')

    const { tracer: logged } = await traced(() =>
      span('logged', { record: 'errors' }, () =>
        emitLog({ body: 'disk almost full', severityNumber: 17 }),
      ),
    )
    expect(logged.names()).toBe('logged')
    expect(logged.logs).toHaveLength(1)
  })

  it('only a local root decides: record on a child is ignored', async () => {
    const { tracer } = await traced(() =>
      span('root', () => span('child', { record: 'errors' }, function* () {})),
    )

    expect(tracer.names()).toBe('child, root')
  })

  it('a late span of a dropped trace surfaces only when it fails', async () => {
    const { tracer } = await traced(function* () {
      let late: Task<unknown> | undefined
      let quiet: Task<unknown> | undefined

      yield* span('root', { record: 'errors' }, function* () {
        quiet = yield* fork(() =>
          span('late-ok', function* () {
            yield* sleep(3)
          }),
        )
        late = yield* fork(() =>
          attempt(() =>
            span('late-failing', function* () {
              yield* sleep(5)
              return yield* fail('app.late')
            }),
          ),
        )
      })

      yield* quiet!
      yield* late!
    })

    expect(tracer.names()).toBe('late-failing')
    expect(tracer.exceptions()).toHaveLength(1)
  })
})
