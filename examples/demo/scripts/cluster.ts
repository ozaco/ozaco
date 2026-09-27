// oxlint-disable import/exports-last
/**
 * `bun run scripts/cluster.ts` — the demo as a CLUSTER in one process: two service nodes
 * (account+todos+media on `api-1`, the rest on `api-2`) behind a gateway on :3000, connected
 * by one in-process memory link and one shared sqlite file.
 *
 * Variations are CONSTS here, not environment variables — `GATEWAYS = 2` adds a second edge on
 * :3001 (a WebRTC call whose two tabs land on DIFFERENT gateways is the case the `rtc` relay
 * coordinates over the carrier: open `/rtc#room` on :3000 and on :3001). For a cluster that
 * ships its telemetry, run `scripts/lgtm.ts` (Grafana + OpenObserve) or `scripts/openobserve.ts`.
 */
import { createQueue, ensure, fork, main, scoped, suspend } from 'std:effect'

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { createLink } from 'transport:impl/memory'

import type { DemoOptions } from '../src'
import { createDemo, HOSTNAME, OBSERVE_TOKEN } from '../src'

const GATEWAYS = 1
const PORT = 3000
const DB_PATH = 'local/demo.sqlite'

/** Boot the whole cluster; `shared` rides into every node (`scripts/lgtm.ts`,
 * `scripts/openobserve.ts`), the first gateway listens on `port`; `ready` runs once every node
 * is up, with the first gateway's url. */
export const runCluster = (
  shared: Pick<DemoOptions, 'otlp' | 'openobserve' | 'capture'> = {},
  port = PORT,
  ready: (url: string) => void = () => {},
): Promise<void> =>
  main(function* () {
    mkdirSync(dirname(DB_PATH), { recursive: true })
    const link = createLink()
    const booted = createQueue<void, void>()

    const node = (options: DemoOptions) =>
      fork(() =>
        scoped(function* () {
          const app = yield* createDemo({ ...options, ...shared, link, dbPath: DB_PATH })
          yield* ensure(() => app.stop())
          const info = yield* app.start()
          console.log(
            `[${options.instance}] ${info.role} hosted=${info.hosted.join(',') || '-'} ${info.url ?? ''}`,
          )
          booted.add(undefined)
          yield* suspend()
        }),
      )

    // port 0 pins each service node to its own ephemeral edge. Nodes boot ONE AT A TIME:
    // they share the sqlite file, and concurrent first-boot migrations would race on it
    yield* node({
      role: 'service',
      hosted: ['account', 'todos', 'media'],
      instance: 'api-1',
      observe: 'forward',
      port: 0,
    })
    yield* booted.next()
    yield* node({
      role: 'service',
      hosted: ['feed', 'reports', 'jobs', 'live', 'rtc', 'cluster'],
      instance: 'api-2',
      observe: 'forward',
      port: 0,
    })
    yield* booted.next()

    // the first gateway collects the observe rows the others forward
    for (let index = 0; index < GATEWAYS; index += 1) {
      yield* node({
        role: 'gateway',
        instance: GATEWAYS > 1 ? `gw-${index + 1}` : 'gw',
        port: port + index,
        observe: index === 0 ? 'collect' : 'forward',
      })
      yield* booted.next()
    }

    const url = `http://${HOSTNAME}:${port}`
    console.log(
      `[cluster] gateways=${GATEWAYS} — docs ${url}/docs · observe ${url}/_observe (bearer: ${OBSERVE_TOKEN} or an admin's JWT)`,
    )
    ready(url)
    yield* suspend()
  })

if (import.meta.main) {
  await runCluster()
}
