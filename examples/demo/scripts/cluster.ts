import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `bun run scripts/cluster.ts` — three nodes in ONE process over a shared memory link: a gateway
 * (edge, collects observe rows) and two service nodes (account+todos+media on `api-1`, the rest
 * on `api-2`), all from the same `createDemo`. Point the client / the panel at the gateway url.
 * With TRANSPORT=nats (or redis) run `bun run src/main.ts` per node instead — same shape, many
 * processes.
 */
import { createQueue, ensure, fork, main, scoped, suspend } from '@ozaco/std/effect'
import { createLink } from '@ozaco/transport/impl/memory'

import { createDemo } from '../src/app'

const link = createLink()

// one database for the three nodes; the change bus rides the same link the carrier does
const dbPath =
  process.env.DB_PATH ?? join(mkdtempSync(join(tmpdir(), 'ozaco-demo-')), 'demo.sqlite')

const node = (env: Record<string, string>, ready: { add(value: void): void }) =>
  fork(() =>
    scoped(function* () {
      const app = yield* createDemo({ env: { ...env, DB_PATH: dbPath }, link })
      yield* ensure(() => app.stop())
      const info = yield* app.start()
      console.log(
        `[${env.INSTANCE}] ${info.role} hosted=${info.hosted.join(',') || '-'} ${info.url ?? ''}`,
      )
      ready.add(undefined)
      yield* suspend()
    }),
  )

await main(function* () {
  const ready = createQueue<void, void>()
  yield* node(
    { ROLE: 'service', SERVICE: 'account,todos,media', INSTANCE: 'api-1', OBSERVE: 'forward' },
    ready,
  )
  yield* node(
    {
      ROLE: 'service',
      SERVICE: 'todo-stats,feed,reports,live,cluster',
      INSTANCE: 'api-2',
      OBSERVE: 'forward',
    },
    ready,
  )
  yield* ready.next()
  yield* ready.next()
  const gateway = yield* createDemo({
    env: {
      ROLE: 'gateway',
      INSTANCE: 'gw',
      PORT: process.env.PORT ?? '3000',
      OBSERVE: 'collect',
      DB_PATH: dbPath,
    },
    link,
  })
  yield* ensure(() => gateway.stop())
  const info = yield* gateway.start()
  console.log(
    `[gw] gateway ready=${info.ready} ${info.url} · docs ${info.url}/docs · observe ${info.url}/_observe`,
  )
  yield* suspend()
})
