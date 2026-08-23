import { createServer } from 'server:core'
import { attempt, run, sleep } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { StarRocksMetrics, starrocksDdl } from 'server:plugins/metrics/starrocks'

import { storage, todos } from '../helpers'

describe('metrics/starrocks', () => {
  it('stream-loads request and span rows with labels + auth; Fail answers count as failed', async () => {
    const loads: { url: string; headers: Record<string, string>; rows: AnyType[] }[] = []
    let answer = { Status: 'Success' }
    const fakeFetch = ((url: AnyType, init: AnyType) => {
      loads.push({ url: String(url), headers: init.headers, rows: JSON.parse(init.body) })
      return Promise.resolve(Response.json(answer))
    }) as typeof fetch
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          plugins: [
            StarRocksMetrics.use({
              url: 'http://fe:8030',
              database: 'metrics',
              user: 'root',
              password: 'pw',
              fetch: fakeFetch,
              batch: { ms: 20 },
            }),
          ],
        })
        yield* server.listen()
        yield* server.call(server.api.todos.create, { title: 'measured' })
        yield* attempt(server.call(server.api.todos.explode, { code: 'x.y' }))
        yield* sleep(80)

        const spans = loads.filter(load => load.url.endsWith('/ozaco_spans/_stream_load'))
        expect(spans.length).toBeGreaterThan(0)
        const first = spans[0]!
        expect(first.url).toBe('http://fe:8030/api/metrics/ozaco_spans/_stream_load')
        expect(first.headers.authorization).toBe(`Basic ${btoa('root:pw')}`)
        expect(first.headers.format).toBe('json')
        expect(first.headers.strip_outer_array).toBe('true')
        expect(first.headers.label).toMatch(/^ozaco-.*-ozaco_spans-\d+-\d+$/u)
        const rows = spans.flatMap(load => load.rows)
        const create = rows.find(row => row.name === 'todos.create')
        expect(create).toMatchObject({ kind: 'dispatch', status: 'ok', action: 'todos.create' })
        expect(create.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/u)
        expect(rows.find(row => row.name === 'todos.explode').status).toBe('failed')
        // every label is unique
        expect(new Set(loads.map(load => load.headers.label)).size).toBe(loads.length)

        // a `Fail` status is a failed batch (counted, not raised)
        answer = { Status: 'Fail', Message: 'too many filtered rows' } as AnyType
        yield* server.call(server.api.todos.create, { title: 'rejected' })
        yield* sleep(80)
        yield* server.stop()
      }),
    )
    expect(starrocksDdl('metrics')).toContain(
      'CREATE TABLE IF NOT EXISTS `metrics`.`ozaco_requests`',
    )
    expect(starrocksDdl('metrics', { spans: null })).not.toContain('ozaco_spans')
  })
})
