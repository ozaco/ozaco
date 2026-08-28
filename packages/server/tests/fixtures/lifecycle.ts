/**
 * Graceful-lifecycle fixture: boots the FULL stack (sqlite + memory transport + network carrier +
 * observe + cors + docs + an edge with a live socket watcher), serves a few requests, stops, and
 * relies on the process exiting NATURALLY. A leaked handle or a surviving pump hangs it and the
 * lifecycle test times out. Prints `all-done` last.
 */
import { column, DbClient, table } from 'db:core'
import { action, createServer, Edge, service } from 'server:core'
import { Cache, Cors, crud, Docs, ObservePlugin } from 'server:plugins'
import { run, until } from 'std:effect'
import { unwrap } from 'std:result'

import { MemoryKv } from 'db:impl/memory-kv'
import { SqliteAdapter } from 'db:impl/sqlite'
import { NetworkCarrier } from 'server:impl/carrier/network'
import { BunEdge } from 'server:impl/edge/bun'
import { BunIO } from 'std:io/impl/bun'
import { MemoryTransport } from 'transport:impl/memory'
import { z } from 'zod'

const items = table('items', { name: column.text() })
const echo = service('echo', {
  say: action.query(
    { input: z.object({ text: z.string() }), output: z.string(), cache: { ttlMs: 1000 } },
    function* ({ input }) {
      return input.text
    },
  ),
})

const outcome = await run(function* () {
  yield* SqliteAdapter.use()
  yield* BunIO.use()
  yield* DbClient.use({ tables: [items] })
  yield* MemoryKv.use()
  yield* MemoryTransport.use({ prefix: 'life' })
  const resource = crud(items)
  const app = yield* createServer({
    services: [echo, resource],
    edge: BunEdge,
    carrier: NetworkCarrier,
    plugins: [ObservePlugin.use({ console: true, batch: { ms: 5 } }), Cors, Cache, Docs],
    listen: { port: 0 },
  })
  const info = yield* app.start()
  const health = yield* until(fetch(`${info.url}/_health`))
  if (health.status !== 200) {
    throw new Error(`health ${health.status}`)
  }
  const said = yield* until(fetch(`${info.url}/echo/say?text=hi`))
  if ((yield* until(said.json())) !== 'hi') {
    throw new Error('echo failed')
  }
  // park a live socket watcher, then let everything close over it
  const ws = new WebSocket(`${info.url!.replace('http', 'ws')}/items/_realtime`)
  yield* until(
    new Promise<void>(resolve => {
      ws.addEventListener('open', () => resolve())
    }),
  )
  ws.send(JSON.stringify({ t: 'watch', id: 'w' }))
  yield* until(
    new Promise<void>(resolve => {
      ws.addEventListener('message', () => resolve(), { once: true })
    }),
  )
  yield* Edge.actions.handle(
    new Request(`${info.url}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    }),
  )
  yield* app.stop()
  console.log('stopped')
})
unwrap(outcome)
console.log('all-done')
