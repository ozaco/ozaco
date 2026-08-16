import { attempt, run } from 'std:effect'
import { IO } from 'std:io'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunIO } from 'std:io/impl/bun'

const decoder = new TextDecoder()

describe('exec', () => {
  it('captures stdout and reports a clean exit', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const result = yield* IO.actions.exec('echo', ['selam'])

      return {
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
        code: result.code,
        signal: result.signal,
        success: result.success,
      }
    })

    expect(unwrap(outcome)).toEqual({
      stdout: 'selam\n',
      stderr: '',
      code: 0,
      signal: null,
      success: true,
    })
  })

  it('a non-zero exit is data on the result, not a Failure', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const result = yield* IO.actions.exec('sh', ['-c', 'printf out; printf err >&2; exit 3'])

      return {
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
        code: result.code,
        success: result.success,
      }
    })

    // reaching the expectation at all proves the run outcome itself was a Success
    expect(unwrap(outcome)).toEqual({
      stdout: 'out',
      stderr: 'err',
      code: 3,
      success: false,
    })
  })

  it('stdin bytes are written to the child and closed', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const result = yield* IO.actions.exec('cat', [], { stdin: 'from-stdin' })
      return decoder.decode(result.stdout)
    })

    expect(unwrap(outcome)).toBe('from-stdin')
  })

  it('env overrides and cwd reach the child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ozaco-io-'))
    const physical = await realpath(dir)

    try {
      const outcome = await run(function* () {
        yield* install(BunIO)

        const result = yield* IO.actions.exec('sh', ['-c', 'printf "%s:" "$OZACO_IO_TEST"; pwd'], {
          cwd: dir,
          env: { OZACO_IO_TEST: 'bayrak' },
        })

        return decoder.decode(result.stdout)
      })

      expect(unwrap(outcome)).toBe(`bayrak:${physical}\n`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a nonexistent binary is a spawn Failure, not an exit status', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const result = yield* attempt(() => IO.actions.exec('ozaco-definitely-not-a-binary'))
      return isFailure(result) ? result.error : 'no-failure'
    })

    expect(unwrap(outcome)).toBe('exec-spawn-failed')
  })

  it('timeout kills a child that runs too long', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const result = yield* IO.actions.exec('sleep', ['2'], { timeout: 50 })
      return { success: result.success, endedEarly: result.code !== 0 || result.signal !== null }
    })

    expect(unwrap(outcome)).toEqual({ success: false, endedEarly: true })
  })
})

describe('spawn', () => {
  it('a ProcessHandle round-trips stdin to stdout and reports a clean exit', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const handle = yield* IO.actions.spawn('cat')
      const out = yield* handle.stdout

      yield* handle.write('ping')
      const first = yield* out.next()

      yield* handle.closeStdin()
      const status = yield* handle.exited()
      const closing = yield* out.next()

      return {
        pidPositive: handle.pid > 0,
        first: first.done === true ? 'ended-early' : decoder.decode(first.value),
        code: status.code,
        success: status.success,
        stdoutClose: closing.done === true ? closing.value : 'still-open',
      }
    })

    expect(unwrap(outcome)).toEqual({
      pidPositive: true,
      first: 'ping',
      code: 0,
      success: true,
      stdoutClose: true,
    })
  })

  it('kill terminates the child and the status carries the signal', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const handle = yield* IO.actions.spawn('sleep', ['5'])
      yield* handle.kill()
      const status = yield* handle.exited()

      return { code: status.code, signal: status.signal, success: status.success }
    })

    expect(unwrap(outcome)).toEqual({ code: null, signal: 'SIGTERM', success: false })
  })

  it('a nonexistent binary fails the spawn as a Result', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const result = yield* attempt(() => IO.actions.spawn('ozaco-definitely-not-a-binary'))
      return isFailure(result) ? result.error : 'no-failure'
    })

    expect(unwrap(outcome)).toBe('spawn-failed')
  })
})
