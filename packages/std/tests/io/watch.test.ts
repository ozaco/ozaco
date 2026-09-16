import { run, sleep, spawn, withResolvers } from 'std:effect'
import type { IODef } from 'std:io'
import { IO } from 'std:io'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir as osTmpdir } from 'node:os'
import { join } from 'node:path'

import { BunIO } from 'std:io/impl/bun'

// The default `watch` path is a Watchman subscription (optional `fb-watchman` + a reachable daemon);
// tests/io/misc.test.ts forces the `fs.watch` fallback via `STD_WATCHMAN=off`. This suite covers the
// Watchman path itself and is skipped when it cannot run: the package is not installed, the daemon
// does not answer, or the kill-switch is set.

/** `true` when `fb-watchman` imports AND a daemon answers a capability check within a short deadline. */
const probeWatchman = async (): Promise<boolean> => {
  if (process.env.STD_WATCHMAN === 'off') {
    return false
  }
  try {
    const mod = await import('fb-watchman')
    const Ctor = mod.Client ?? (mod as { default?: { Client?: typeof mod.Client } }).default?.Client
    if (!Ctor) {
      return false
    }
    const client = new Ctor()
    client.on('error', () => {})
    const answered = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 3000)
      client.capabilityCheck({ optional: [], required: ['wildmatch'] }, error => {
        clearTimeout(timer)
        resolve(!error)
      })
    })
    client.end()
    return answered
  } catch {
    return false
  }
}

const watchmanUsable = await probeWatchman()

describe.skipIf(!watchmanUsable)('watch (Watchman path)', () => {
  it('reports a file change with the same relative `path` the fs.watch fallback yields', async () => {
    const dir = await mkdtemp(join(osTmpdir(), 'ozaco-io-watchman-'))

    try {
      const outcome = await run(function* () {
        yield* BunIO.use()

        const events = yield* IO.actions.watch(dir)
        const got = withResolvers<IODef.WatchEvent>()

        yield* spawn(function* () {
          const first = yield* events.next()
          if (!first.done) {
            got.resolve(first.value)
          }
        })

        // poke the directory until the subscription reports; Watchman settles asynchronously
        yield* spawn(function* () {
          for (let tick = 0; tick < 40; tick++) {
            yield* IO.actions.write(join(dir, 'poke.txt'), `tick-${tick}`)
            yield* sleep(100)
          }
        })

        return yield* got.operation
      })

      const event = unwrap(outcome)
      expect(event.type === 'rename' || event.type === 'change').toBe(true)
      // Watchman names files relative to the subscription's relative_root — the same base the
      // fs.watch fallback reports (`filename` relative to the watched directory).
      expect(event.path).toBe('poke.txt')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 8000)
})
