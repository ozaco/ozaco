import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQueue, fork, run, scoped, sleep, until } from '@ozaco/std/effect'
import { unwrap } from '@ozaco/std/result'
import type { AnyType } from '@ozaco/std/shared'
import { createLink } from '@ozaco/transport/impl/memory'

import { createDemo } from '../src/app'
import type { Step } from '../src/client'
import { walk } from '../src/client'

const detail = (steps: Step[], name: string): AnyType =>
  steps.find(step => step.name === name)?.detail

describe('demo — every use case end to end', () => {
  it('boots the monolith and the typed client walks through it all', async () => {
    unwrap(
      await run(function* () {
        const app = yield* createDemo({ env: { ROLE: 'monolith', INSTANCE: 'mono', PORT: '0' } })
        const info = yield* app.start()
        expect(info.ready).toBe(true)
        const steps = yield* walk(info.url!)

        expect(detail(steps, 'manifest').services).toEqual([
          'account',
          'todos',
          'feed',
          'media',
          'reports',
          'live',
          'rtc',
          'cluster',
          'observe',
        ])
        expect(detail(steps, 'manifest').sockets).toEqual([
          '/todos/_realtime',
          '/live/chat',
          '/rtc/:room',
        ])
        expect(detail(steps, 'whoami anonymous')).toBe('server.unauthorized')
        expect(detail(steps, 'login + whoami')).toMatchObject({ roles: ['admin'], type: 'access' })
        expect(detail(steps, 'refresh')).toEqual({ rotated: true })
        expect(detail(steps, 'refresh replay')).toBe('server.unauthorized')
        expect(detail(steps, 'admin-only promote')).toEqual({ ok: true })
        expect(detail(steps, 'todos crud')).toMatchObject({
          created: 'write the demo',
          updatedDone: true,
          staleWrite: 'db.conflict',
          listed: 1,
        })
        expect(detail(steps, 'realtime watch')).toEqual({ syncRows: 1, afterCreate: 2 })
        expect(detail(steps, 'crud hooks')).toEqual({
          trimmed: 'hooked',
          shouted: 'HOOKED',
          removeDenied: 'server.forbidden',
          errorTagged: true,
        })
        expect(detail(steps, 'crud extend')).toEqual({
          stats: { low: 0, normal: 1, high: 0 },
          replaceDisabled: 'client.no-route',
        })
        expect(detail(steps, 'crud schema')).toEqual({ rejected: 'server.validation' })
        expect(detail(steps, 'crud ops')).toEqual({ open: ['seen live'], total: 1 })
        expect(detail(steps, 'streams')).toEqual({ ndjson: 3, sse: 2, text: 'a b c ', bytes: 4096 })
        expect(detail(steps, 'uploads')).toMatchObject({
          upload: 3000,
          ingest: 5000,
          listBefore: 0,
          listAfter: 1,
          downloaded: 3000,
          missing: 'media.not-found',
        })
        expect(detail(steps, 'cache')).toEqual({ hit: true, recomputedAfterInvalidate: true })
        const resilience = detail(steps, 'resilience')
        expect(resilience.retryAttempts).toBe(3)
        expect(resilience.fallback).toBe('fallback')
        expect(resilience.limited).toEqual([
          'ok',
          'ok',
          'ok',
          'server.rate-limited',
          'server.rate-limited',
        ])
        expect(resilience.breaker.slice(0, 3)).toEqual([
          'reports.boom',
          'reports.boom',
          'reports.boom',
        ])
        expect(resilience.breaker[3]).toBe('server.unavailable')
        expect(detail(steps, 'nested ctx.call')).toEqual({ todos: 2, uploads: 1 })
        expect(detail(steps, 'events')).toEqual(['demo.ping'])
        expect(detail(steps, 'slow within deadline')).toMatchObject({ aborted: false })
        expect(detail(steps, 'cluster').servedBy).toBe('mono')
        expect(detail(steps, 'cluster').members.todos).toEqual(['mono'])
        expect(detail(steps, 'validation failure').tag).toBe('server.validation')
        expect(typeof detail(steps, 'last request id')).toBe('string')

        // the docs panel, the observe console and health answer on the edge
        for (const path of [
          '/docs',
          '/docs/manifest',
          '/_observe',
          '/_observe/api/cluster',
          '/_health',
          '/',
        ]) {
          const response = yield* until(fetch(`${info.url}${path}`))
          expect([path, response.status]).toEqual([path, 200])
        }
        yield* app.stop()
      }),
    )
  })
})

describe('demo — cluster', () => {
  it('gateway + two service nodes over one link: calls route by presence, observe rows collect', async () => {
    const link = createLink()
    // one database for the cluster (a file every node opens), the bus on the shared link
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ozaco-demo-')), 'demo.sqlite')
    unwrap(
      await run(function* () {
        const ready = createQueue<void, void>()
        const node = (env: Record<string, string>) =>
          fork(() =>
            scoped(function* () {
              const app = yield* createDemo({ env: { ...env, DB_PATH: dbPath }, link })
              yield* app.start()
              ready.add(undefined)
              yield* sleep(60_000)
            }),
          )
        const api1 = yield* node({
          ROLE: 'service',
          SERVICE: 'account,todos,media',
          INSTANCE: 'api-1',
          OBSERVE: 'forward',
        })
        const api2 = yield* node({
          ROLE: 'service',
          SERVICE: 'feed,reports,live,rtc,cluster',
          INSTANCE: 'api-2',
          OBSERVE: 'forward',
        })
        yield* ready.next()
        yield* ready.next()
        const gateway = yield* createDemo({
          env: { ROLE: 'gateway', INSTANCE: 'gw', PORT: '0', OBSERVE: 'collect', DB_PATH: dbPath },
          link,
        })
        const info = yield* gateway.start()
        expect(info).toMatchObject({ role: 'gateway', hosted: [], ready: true })

        const steps = yield* walk(info.url!)
        expect(detail(steps, 'cluster').servedBy).toBe('api-2')
        expect(detail(steps, 'cluster').members).toMatchObject({
          todos: ['api-1'],
          feed: ['api-2'],
        })
        expect(detail(steps, 'streams')).toEqual({ ndjson: 3, sse: 2, text: 'a b c ', bytes: 4096 })
        expect(detail(steps, 'uploads')).toMatchObject({
          upload: 3000,
          ingest: 5000,
          downloaded: 3000,
        })
        expect(detail(steps, 'nested ctx.call')).toEqual({ todos: 2, uploads: 1 })
        expect(detail(steps, 'realtime watch')).toEqual({ syncRows: 1, afterCreate: 2 })
        // the hooks run on the node HOSTING todos (api-1), not on the gateway
        expect(detail(steps, 'crud hooks')).toMatchObject({ trimmed: 'hooked', shouted: 'HOOKED' })
        // the extend action routes over the carrier like any other todos action
        expect(detail(steps, 'crud extend')).toMatchObject({ stats: { normal: 1 } })

        // the gateway's observe store holds the service nodes' spans (forward → collect)
        yield* sleep(300)
        const clusterView = yield* until(fetch(`${info.url}/_observe/api/cluster`))
        const view = (yield* until(clusterView.json())) as AnyType
        expect(view.instances.map((entry: AnyType) => entry.instance).toSorted()).toEqual([
          'api-1',
          'api-2',
          'gw',
        ])
        const health = (yield* until(
          (yield* until(fetch(`${info.url}/_health`))).json(),
        )) as AnyType
        expect(health.members.todos.map((member: AnyType) => member.instance)).toEqual(['api-1'])

        yield* gateway.stop()
        yield* api1.halt()
        yield* api2.halt()
      }),
    )
  })
})
