import { Broker, DataType, DefaultBroker } from 'server:core'
import { Daemon } from 'server:daemon'
import { mutation, query, resource } from 'server:wizard'
import { main, suspend } from 'std:effect'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'

import { BunGateway } from 'server:gateway/bun'
import { Docs } from 'server:plugin/docs'
import { NatsTransport } from 'server:transport/nats'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'
import { z } from 'zod'

/**
 * Wizard resources deployed through the DAEMON — one entry file, every topology:
 *
 *   bun dist/advanced/daemon.js                    → monolith (no NATS, no infra at all)
 *   SERVICE=notes  bun dist/advanced/daemon.js     → headless pod owning `notes`
 *   SERVICE=stats  bun dist/advanced/daemon.js     → headless pod owning `stats`
 *   SERVICE=gateway PORT=3100 bun …/daemon.js      → edge: mounts every route, owns nothing
 *   CLUSTER=1 bun dist/advanced/daemon.js          → forks one child per module, stays on as gateway
 *
 * `SERVICE` always comes from the environment (each pod / each fork must be nameable from
 * outside); `Daemon`'s `service` OPTION is the programmatic fallback for env-less boots — tests,
 * embedding — and the env var always beats it.
 *
 * Try it (wizard functions are POST by convention — /<ns>/<fn>):
 *   curl -X POST localhost:3100/notes/add -H 'content-type: application/json' -d '{"text":"hi"}'
 *   curl -X POST localhost:3100/notes/list -H 'content-type: application/json' -d '{}'
 *   curl -X POST localhost:3100/stats/overview -H 'content-type: application/json' -d '{}'
 *   #                                       ^ gateway → stats pod → notes pod, two NATS hops
 */

// ── resources: plain wizard, nothing daemon-specific ─────────────────────────────────────────────

const memory: { id: string; text: string }[] = []

const notes = resource('notes', {
  add: mutation({
    args: z.object({ text: z.string() }),
    returns: z.object({ id: z.string() }),
    *handler({ text }) {
      const id = crypto.randomUUID()
      memory.push({ id, text })
      return { id }
    },
  }),
  list: query({
    returns: z.array(z.object({ id: z.string(), text: z.string() })),
    *handler() {
      return memory
    },
  }),
})

const stats = resource('stats', {
  overview: query({
    returns: z.object({ notes: z.number() }),
    *handler() {
      // Cross-service by ADDRESS, not by import of live state: in a split topology this pod does
      // not hold the notes array — the call rides NATS to whichever pod owns `notes`.
      const list = (yield* Broker.actions.call('notes', 'list', [
        { type: DataType.normal, value: {} },
      ])) as unknown[]
      return { notes: list.length }
    },
  }),
})

// ── the daemon: role-resolved bootstrap, one `base` for every process kind ───────────────────────

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.info })
  yield* install(ConsoleTransport)

  yield* install(Daemon, {
    // CLUSTER=1 → this process forks one child per module and carries on as the gateway
    cluster: ['1', 'true', 'yes'].includes(String(process.env.CLUSTER ?? '').toLowerCase()),

    // The app's units. No `route` = self-wiring: a wizard resource mounts its own paths (REST +
    // realtime + streams) by role — listing it here only tells the daemon which process OWNS it.
    modules: [
      { name: 'notes', service: notes },
      { name: 'stats', service: stats },
    ],

    *base(rt) {
      yield* install(DefaultBroker)

      // A monolith needs no wire at all; every other kind talks over NATS. One prefix per APP —
      // never share it with another app on the same server — and the role as the event group.
      if (rt.kind !== 'monolith') {
        yield* install(NatsTransport, {
          servers: process.env.NATS_URL ?? 'nats://localhost:4222',
          subjectPrefix: 'wizard-daemon',
          ...(rt.service ? { queueGroup: rt.service } : {}),
        })
      }

      // Only route-serving processes hold a port; a service pod stays headless.
      if (rt.kind !== 'service') {
        yield* install(BunGateway, { port: +(process.env.PORT ?? 3100), host: '127.0.0.1' })
        yield* install(Docs, { silent: true })
      }
    },

    *ready(rt, mounted) {
      if (rt.kind !== 'service') {
        yield* Docs.actions.from(...mounted)
      }
      yield* Logger.actions.info(
        `daemon ready · kind=${rt.kind} service=${rt.service ?? '-'} · routes=${mounted.length}`,
      )
    },
  })

  yield* Daemon.actions.start()
  yield* suspend()
})
