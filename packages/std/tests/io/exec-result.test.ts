import { attempt, run } from 'std:effect'
import { IO } from 'std:io'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { NodeIO } from 'std:io/impl/node'

// The readers an `ExecResult` carries over its buffered streams: `text()` / `said()` / `must(tag)`.

describe.each([
  ['BunIO', BunIO],
  ['NodeIO', NodeIO],
] as const)('%s: ExecResult text / said / must', (_, impl) => {
  it('text() is stderr then stdout decoded; said() is that trimmed', async () => {
    const outcome = await run(function* () {
      yield* impl.use()

      const result = yield* IO.actions.exec('sh', ['-c', 'printf " out\n"; printf "err " >&2'])

      return { text: result.text(), said: result.said(), success: result.success }
    })

    expect(unwrap(outcome)).toEqual({ text: 'err  out\n', said: 'err  out', success: true })
  })

  it('said() of a silent child is its exit code, or its signal', async () => {
    const outcome = await run(function* () {
      yield* impl.use()

      const code = yield* IO.actions.exec('sh', ['-c', 'exit 7'])
      const signalled = yield* IO.actions.exec('sh', ['-c', 'kill -TERM $$'])

      return { code: code.said(), signalled: signalled.said() }
    })

    expect(unwrap(outcome)).toEqual({ code: 'exit code 7', signalled: 'SIGTERM' })
  })

  it('must(tag) returns text() on success and fails `tag` with the command line + said()', async () => {
    const outcome = await run(function* () {
      yield* impl.use()

      const fine = yield* IO.actions.exec('printf', ['fine'])
      const broken = yield* IO.actions.exec('sh', ['-c', 'echo broke >&2; exit 2'])
      const failure = yield* attempt(() => broken.must('demo.git'))

      return {
        fine: yield* fine.must('demo.git'),
        error: isFailure(failure) ? failure.error : 'no-failure',
        message: isFailure(failure) ? failure.message : 'no-failure',
      }
    })

    expect(unwrap(outcome)).toEqual({
      fine: 'fine',
      error: 'demo.git',
      message: 'sh -c echo broke >&2; exit 2\nbroke',
    })
  })
})
