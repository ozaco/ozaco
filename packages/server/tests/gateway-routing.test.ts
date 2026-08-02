import { describe, expect, it } from 'bun:test'

import { Broker, defineAction, DefaultBroker, Gateway } from '@ozaco/server/core'
import { BunGateway } from '@ozaco/server/gateway/bun'
import { run, suspend } from '@ozaco/std/effect'
import { BunIO } from '@ozaco/std/io/impl/bun'
import { DefaultLogger, LogLevel } from '@ozaco/std/logger'
import { install } from '@ozaco/std/plugin'
import type { AnyType } from '@ozaco/std/shared'
import { z } from 'zod'

const wait = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(() => resolve(), ms)
  })

describe('listen() under a mount claim (S5)', () => {
  it('upgrades a raw WS route whose path a resource mount claims', async () => {
    const port = 39_410

    // the mount that claims the `/flow` subtree — the live repro's guarded POST route
    const ingest = defineAction(
      {
        title: 'ingest',
        input: z.object({}),
        settings: [Gateway.actions.rest({ method: 'POST', path: '/test-runs/audio' })],
      },
      function* () {
        return { via: 'rest' }
      },
    )

    const ready = Promise.withResolvers<void>()
    const task = run(function* () {
      yield* install(BunIO)
      yield* install(DefaultLogger, { level: LogLevel.silent })
      yield* install(DefaultBroker)
      yield* install(BunGateway, { port })
      yield* Gateway.actions.mount('/flow', ingest)
      // the raw WS route registers at the root prefix — before the WS claim exemption the mount
      // above silently 404'd this upgrade and the request fell back to REST
      yield* Gateway.actions.listen('/flow/test-runs/audio', {
        *open(socket) {
          yield* socket.send({ event: 'ready' })
        },
      })
      yield* Broker.actions.start()
      yield* Gateway.actions.start({ port })
      ready.resolve()
      yield* suspend()
    })
    await ready.promise
    await wait(50)

    const frames: AnyType[] = []
    const opened = Promise.withResolvers<void>()
    const ws = new WebSocket(`ws://localhost:${port}/flow/test-runs/audio`)
    ws.addEventListener('message', event => frames.push(JSON.parse(String(event.data))))
    ws.addEventListener('open', () => opened.resolve(), { once: true })
    ws.addEventListener('error', () => opened.reject(new Error('upgrade failed')), { once: true })

    await opened.promise
    await wait(150)
    expect(frames).toEqual([{ event: 'ready' }])

    ws.close()
    await wait(50)
    await task.halt()
  })

  it('still shadows REST methods falling through to an outer :param route', async () => {
    const port = 39_411

    const outer = defineAction(
      {
        title: 'kb.update',
        input: z.object({ id: z.string() }),
        settings: [Gateway.actions.rest({ method: 'PATCH', path: '/:id' })],
      },
      function* (body: AnyType) {
        return { updated: body.id }
      },
    )
    const inner = defineAction(
      {
        title: 'files.list',
        settings: [Gateway.actions.rest({ method: 'GET', path: '/' })],
      },
      function* () {
        return { files: [] }
      },
    )

    const ready = Promise.withResolvers<void>()
    const task = run(function* () {
      yield* install(BunIO)
      yield* install(DefaultLogger, { level: LogLevel.silent })
      yield* install(DefaultBroker)
      yield* install(BunGateway, { port })
      yield* Gateway.actions.mount('/kb', outer)
      yield* Gateway.actions.mount('/kb/files', inner)
      yield* Broker.actions.start()
      yield* Gateway.actions.start({ port })
      ready.resolve()
      yield* suspend()
    })
    await ready.promise
    await wait(50)

    // the deeper mount still owns its subtree for methods it does not define
    const shadowed = await fetch(`http://localhost:${port}/kb/files`, { method: 'PATCH' })
    expect(shadowed.status).toBe(404)

    // while the routes each mount does define keep working
    const innerRes = await fetch(`http://localhost:${port}/kb/files`)
    expect(await innerRes.json()).toEqual({ files: [] })
    const outerRes = await fetch(`http://localhost:${port}/kb/one`, { method: 'PATCH' })
    expect(await outerRes.json()).toEqual({ updated: 'one' })

    await task.halt()
  })
})

describe('query/path param coercion', () => {
  const search = defineAction(
    {
      title: 'search',
      input: z.object({
        limit: z.number().default(50),
        active: z.boolean().optional(),
        q: z.string().optional(),
        mixed: z.union([z.string(), z.number()]).optional(),
      }),
      settings: [Gateway.actions.rest({ method: 'GET', path: '/search' })],
    },
    function* (body: AnyType) {
      return body
    },
  )

  const item = defineAction(
    {
      title: 'item',
      input: z.object({ id: z.number() }),
      settings: [Gateway.actions.rest({ method: 'GET', path: '/items/:id' })],
    },
    function* (body: AnyType) {
      return body
    },
  )

  it('coerces GET params into the primitives the arg schema declares', async () => {
    const port = 39_412
    const ready = Promise.withResolvers<void>()
    const task = run(function* () {
      yield* install(BunIO)
      yield* install(DefaultLogger, { level: LogLevel.silent })
      yield* install(DefaultBroker)
      yield* install(BunGateway, { port })
      yield* Gateway.actions.mount('/api', search)
      yield* Gateway.actions.mount('/api', item)
      yield* Broker.actions.start()
      yield* Gateway.actions.start({ port })
      ready.resolve()
      yield* suspend()
    })
    await ready.promise
    await wait(50)

    // number + boolean coerce; a string-typed key and a string|number union stay strings
    const res = await fetch(`http://localhost:${port}/api/search?limit=5&active=true&q=42&mixed=42`)
    expect(await res.json()).toEqual({ limit: 5, active: true, q: '42', mixed: '42' })

    // defaults still apply when the param is absent
    const defaulted = await fetch(`http://localhost:${port}/api/search`)
    expect(await defaulted.json()).toEqual({ limit: 50 })

    // path params coerce too
    const byId = await fetch(`http://localhost:${port}/api/items/7`)
    expect(await byId.json()).toEqual({ id: 7 })

    // an unparseable value still fails validation instead of sneaking through
    const bad = await fetch(`http://localhost:${port}/api/search?limit=abc`)
    expect(bad.status).toBeGreaterThanOrEqual(400)

    await task.halt()
  })
})
