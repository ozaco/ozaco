/**
 * The IO rewrap sites (net sockets, node crypto, processes) fail with the IO tag and what they were
 * doing, the platform failure nested under it (`fail(Tag, message, asFailure(error, IOErrors))`):
 * folded through the `IOErrors` matchers (`ENOENT` → `std:io.not-found`, …) or
 * `std:result.unknown`, the platform error kept as that level's `raw`.
 */
import { attempt, run, sleep } from 'std:effect'
import { IO } from 'std:io'
import type { Result } from 'std:result'
import { formatFailure, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { NodeIO } from 'std:io/impl/node'

/** The failure and the failures nested in it, outer → inner (first nested failure each). */
const failuresOf = (outcome: unknown): Result.Failure<unknown>[] => {
  const out: Result.Failure<unknown>[] = []

  for (let at: unknown = outcome; isFailure(at); at = at.causes.find(isFailure)) {
    out.push(at)
  }

  return out
}

/** Each level's tag and, on a fold, the platform error's `code` (read off its `raw`). */
const levelsOf = (outcome: unknown) =>
  failuresOf(outcome).map(failure => ({
    type: String(failure.error),
    code: (failure.raw as { code?: unknown } | undefined)?.code,
  }))

describe('io failures nest their platform cause', () => {
  it('a refused tcp connect: tcp-connect-failed caused by the ECONNREFUSED Error', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()

      const server = yield* IO.actions.tcpListen({ port: 0 }, function* () {})
      const deadPort = server.port

      yield* server.close()
      yield* sleep(20)

      const refused = yield* attempt(() => IO.actions.tcpConnect({ port: deadPort }))
      const levels = levelsOf(refused)

      return {
        tag: isFailure(refused) ? refused.error : 'no-failure',
        message: isFailure(refused) ? refused.message : '',
        levels: levels.length,
        inner: levels[1]?.type,
        code: levels[1]?.code,
        rendered: isFailure(refused) ? formatFailure(refused, { chain: true }) : '',
      }
    })

    const seen = unwrap(outcome)

    expect(seen.tag).toBe('std:io.tcp-connect-failed')
    // the message says what failed; the platform's text is the level under it
    expect(seen.message).toMatch(/^tcp connect to 127\.0\.0\.1:\d+ failed$/u)
    expect(seen.levels).toBe(2)
    expect(seen.inner).toBe('std:result.unknown')
    expect(seen.code).toBe('ECONNREFUSED')
    expect(seen.rendered).toContain('\nCaused by: std:result.unknown: ')
    expect(seen.rendered).toContain('ECONNREFUSED')
  })

  it('decrypt / sign failures nest the crypto Error', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()

      const sealed = yield* IO.actions.encrypt('secret', 'right-passphrase')
      const wrongSecret = yield* attempt(() => IO.actions.decrypt(sealed, 'wrong-passphrase'))

      const pair = yield* IO.actions.generateKeyPair()
      const broken = yield* attempt(() => IO.actions.sign('message', pair.privateKey.slice(0, 10)))

      return {
        decrypt: levelsOf(wrongSecret).map(level => level.type),
        sign: levelsOf(broken).map(level => level.type),
      }
    })

    const seen = unwrap(outcome)

    expect(seen.decrypt[0]).toBe('std:io.decrypt-failed')
    expect(seen.decrypt).toHaveLength(2)
    expect(seen.sign[0]).toBe('std:io.sign-failed')
    expect(seen.sign).toHaveLength(2)
  })

  it('a command that cannot be spawned: spawn-failed caused by the platform error', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()

      const missing = yield* attempt(() =>
        IO.actions.exec('ozaco-no-such-command-for-the-cause-test', []),
      )

      return levelsOf(missing).map(level => level.type)
    })

    const types = unwrap(outcome)

    expect(types[0]).toMatch(/^std:io\.exec-(spawn-)?failed$/u)
    expect(types.length).toBeGreaterThanOrEqual(2)
  })

  it('an async process error (NodeIO exited): process-error over the not-found fold', async () => {
    const outcome = await run(function* () {
      yield* NodeIO.use()

      const child = yield* IO.actions.spawn('ozaco-no-such-command-for-the-cause-test', [])
      const exited = yield* attempt(() => child.exited())

      return {
        tag: isFailure(exited) ? exited.error : 'no-failure',
        message: isFailure(exited) ? exited.message : '',
        types: levelsOf(exited).map(level => level.type),
      }
    })

    const seen = unwrap(outcome)

    expect(seen.tag).toBe('std:io.process-error')
    expect(seen.message).toBe('process "ozaco-no-such-command-for-the-cause-test" errored')
    // one level down: the runtime's fold re-classified by the IOErrors matchers (ENOENT)
    expect(seen.types).toEqual(['std:io.process-error', 'std:io.not-found'])
  })
})
