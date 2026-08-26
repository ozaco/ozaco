import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `bun run scripts/cluster.ts` — the demo as a CLUSTER in one process: two service nodes
 * (account+todos+media on `api-1`, the rest on `api-2`) behind one or more gateways, all from the
 * same `createDemo`.
 *
 * The carrier comes from the environment:
 *
 *   (default)                     one in-process memory link — no infrastructure needed
 *   TRANSPORT=nats                a NATS server with JetStream: `nats-server -js`
 *     NATS_URL=nats://127.0.0.1:4222   (default)
 *   TRANSPORT=redis               REDIS_URL=redis://127.0.0.1:6379
 *
 * With a real carrier the nodes no longer share a link, so the same command can be run once per
 * process (or once per machine) — this script just starts them together for convenience.
 *
 *   GATEWAYS=2   start two edge nodes (PORT, PORT+1, …). A WebRTC call whose two tabs land on
 *                DIFFERENT gateways is the case the `rtc` relay coordinates over the carrier —
 *                open `http://127.0.0.1:3000/rtc#room` in one tab and `:3001/rtc#room` in the
 *                other to exercise it.
 */
import { createQueue, ensure, fork, main, scoped, suspend } from '@ozaco/std/effect'
import { createLink } from '@ozaco/transport/impl/memory'

import { createDemo } from '../src/app'

const transport = process.env.TRANSPORT ?? 'memory'

// a real carrier connects the nodes on its own; the memory one needs the shared link object
const link = transport === 'memory' ? createLink() : undefined

// one database for every node; the change bus rides the same carrier
const dbPath =
  process.env.DB_PATH ?? join(mkdtempSync(join(tmpdir(), 'ozaco-demo-')), 'demo.sqlite')

const gateways = Number(process.env.GATEWAYS ?? 1)
const basePort = Number(process.env.PORT ?? 3000)

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
  // PORT: '0' pins the service nodes to their own ephemeral edge port — without it a
  // process-level PORT (meant for the gateway) leaks into every node and they fight over it
  yield* node(
    {
      ROLE: 'service',
      SERVICE: 'account,todos,media',
      INSTANCE: 'api-1',
      OBSERVE: 'forward',
      PORT: '0',
    },
    ready,
  )
  yield* node(
    {
      ROLE: 'service',
      SERVICE: 'feed,reports,live,rtc,cluster',
      INSTANCE: 'api-2',
      OBSERVE: 'forward',
      PORT: '0',
    },
    ready,
  )
  yield* ready.next()
  yield* ready.next()

  // the first gateway collects the observe rows the others forward
  for (let index = 0; index < gateways; index += 1) {
    yield* node(
      {
        ROLE: 'gateway',
        INSTANCE: gateways > 1 ? `gw-${index + 1}` : 'gw',
        PORT: String(basePort + index),
        OBSERVE: index === 0 ? 'collect' : 'forward',
        DB_PATH: dbPath,
      },
      ready,
    )
    yield* ready.next()
  }

  console.log(
    `[cluster] transport=${transport} gateways=${gateways} — docs http://127.0.0.1:${basePort}/docs · observe http://127.0.0.1:${basePort}/_observe`,
  )
  yield* suspend()
})
