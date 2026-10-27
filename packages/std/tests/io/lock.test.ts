import { attempt, run, scoped, until } from 'std:effect'
import { IO, IOErrors } from 'std:io'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunIO } from 'std:io/impl/bun'

// `IO.actions.lock(path)`: one holder at a time, a dead holder swept, released with the scope.

describe('lock', () => {
  it('refuses a held lock after waitMs, takes a dead holder over, releases on release() and at scope close', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ozaco-lock-'))
    const path = join(dir, 'instance.lock')

    try {
      const outcome = unwrap(
        await run(function* () {
          yield* BunIO.use()

          const held = yield* IO.actions.lock(path, { record: { label: 'first' } })
          const busy = yield* attempt(() => IO.actions.lock(path, { waitMs: 60, pollMs: 10 }))

          yield* held.release()
          yield* held.release()

          // the holder is gone: taken at once
          const again = yield* IO.actions.lock(path)

          yield* again.release()

          // a stale lock (its pid is nobody's) is swept and taken
          yield* until(mkdir(path, { recursive: true }))
          yield* until(
            writeFile(
              join(path, 'lock.json'),
              JSON.stringify({ pid: 999_999, startedAt: 1, record: 'ghost' }),
            ),
          )

          const swept = yield* IO.actions.lock(path, { record: 'live' })

          expect(swept.holder.pid).toBe(process.pid)
          yield* swept.release()

          // the scope's close lets go too
          yield* scoped(function* () {
            yield* IO.actions.lock(path)
          })

          return {
            busy: isFailure(busy) ? busy.error : null,
            cause: isFailure(busy) ? busy.causes[0] : null,
            heldPid: held.holder.pid,
            freeAfterScope: !(yield* IO.actions.exists(path)),
          }
        }),
      )

      expect(outcome).toEqual({
        busy: IOErrors.Busy,
        cause: 'lock:held',
        heldPid: process.pid,
        freeAfterScope: true,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
