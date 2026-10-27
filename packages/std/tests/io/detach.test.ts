import { attempt, run, sleep } from 'std:effect'
import { IO, IOErrors } from 'std:io'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunIO } from 'std:io/impl/bun'
import { NodeIO } from 'std:io/impl/node'

// `spawn` beyond the pipes: `'ignore'` and file streams, `detached` + `handle.detach()` (a child
// that outlives its parent), and `run` (the child on the parent's terminal).

const decoder = new TextDecoder()
const SRC = join(import.meta.dir, '../../src')

const errorOf = (outcome: unknown): string =>
  isFailure(outcome) ? (outcome.error as string) : 'no-failure'

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'ozaco-io-detach-'))

  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Run `body` as a standalone Bun script (std imported from source) and capture what it printed —
 * what reaches the REAL terminal streams, and whether the script's process itself came back. */
const runScript = async (dir: string, body: string) => {
  const file = join(dir, 'script.ts')

  await writeFile(
    file,
    [
      `import { run } from '${SRC}/effect/index.ts'`,
      `import { IO } from '${SRC}/io/index.ts'`,
      `import { BunIO } from '${SRC}/io/impl/bun.ts'`,
      `import { NodeIO } from '${SRC}/io/impl/node.ts'`,
      `const outcome = await run(function* () {`,
      body,
      `})`,
      `if (outcome._t !== undefined && 'error' in outcome) { console.error(String(outcome.error)); process.exit(2) }`,
    ].join('\n'),
  )

  const outcome = await run(function* () {
    yield* BunIO.use()

    return yield* IO.actions.exec(process.execPath, [file])
  })
  const result = unwrap(outcome)

  return {
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
    code: result.code,
  }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

describe.each([
  ['BunIO', BunIO],
  ['NodeIO', NodeIO],
] as const)('%s: stdio ignore / file', (_, impl) => {
  it("'ignore' wires the null device: empty flows, a failing write, the child reads nothing", async () => {
    const outcome = await run(function* () {
      yield* impl.use()

      const handle = yield* IO.actions.spawn('sh', ['-c', 'cat; printf out'], { stdio: 'ignore' })
      const out = yield* handle.stdout
      const first = yield* out.next()
      const written = yield* attempt(() => handle.write('nope'))
      const status = yield* handle.exited()

      return {
        stdout: first.done === true ? first.value : 'had-data',
        write: errorOf(written),
        success: status.success,
      }
    })

    expect(unwrap(outcome)).toEqual({
      stdout: true,
      write: IOErrors.StdinWriteFailed,
      success: true,
    })
  })

  it('a file per stream: stdin read from one, stdout created with mode, stderr appended', async () => {
    await withTempDir(async dir => {
      const input = join(dir, 'in.txt')
      const out = join(dir, 'out.log')
      const err = join(dir, 'err.log')

      await writeFile(input, 'from-file')
      await writeFile(err, 'first\n')

      const outcome = await run(function* () {
        yield* impl.use()

        const handle = yield* IO.actions.spawn('sh', ['-c', 'cat; printf second >&2'], {
          stdio: {
            stdin: { file: input },
            stdout: { file: out, mode: 0o600 },
            stderr: { file: err, append: true },
          },
        })
        const first = yield* (yield* handle.stdout).next()
        const status = yield* handle.exited()

        return { flowEmpty: first.done === true, success: status.success }
      })

      const outInfo = await stat(out)

      expect(unwrap(outcome)).toEqual({ flowEmpty: true, success: true })
      expect(await readFile(out, 'utf8')).toBe('from-file')
      expect(outInfo.mode & 0o777).toBe(0o600)
      expect(await readFile(err, 'utf8')).toBe('first\nsecond')
    })
  })

  it('a stdin file that does not exist fails the spawn std:io.not-found', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* impl.use()

        return errorOf(
          yield* attempt(() =>
            IO.actions.spawn('cat', [], { stdio: { stdin: { file: join(dir, 'missing') } } }),
          ),
        )
      })

      expect(unwrap(outcome)).toBe(IOErrors.NotFound)
    })
  })
})

describe.each([
  ['BunIO', BunIO],
  ['NodeIO', NodeIO],
] as const)('%s: run', (_, impl) => {
  it("shares the parent's terminal and answers the exit status", async () => {
    await withTempDir(async dir => {
      const printed = await runScript(
        dir,
        `
        yield* ${impl === BunIO ? 'BunIO' : 'NodeIO'}.use()
        const status = yield* IO.actions.run('sh', ['-c', 'printf ran-out; printf ran-err >&2; exit 4'])
        console.log(JSON.stringify(status))
      `,
      )

      expect(printed).toEqual({
        stdout: 'ran-out{"code":4,"signal":null,"success":false}\n',
        stderr: 'ran-err',
        code: 0,
      })
    })
  })

  it('stdio can be ignored per run', async () => {
    const outcome = await run(function* () {
      yield* impl.use()

      return yield* IO.actions.run('sh', ['-c', 'echo silenced; exit 3'], { stdio: 'ignore' })
    })

    expect(unwrap(outcome)).toEqual({ code: 3, signal: null, success: false })
  })
})

describe.each([
  ['BunIO', BunIO],
  ['NodeIO', NodeIO],
] as const)('%s: detached + detach()', (_, impl) => {
  it('a detached child outlives the parent process that let it go', async () => {
    await withTempDir(async dir => {
      const marker = join(dir, 'done.txt')
      const printed = await runScript(
        dir,
        `
          yield* ${impl === BunIO ? 'BunIO' : 'NodeIO'}.use()
          const handle = yield* IO.actions.spawn('sh', ['-c', 'sleep 3; echo done > "${marker}"'], { detached: true, stdio: 'ignore' })
          yield* handle.detach()
          console.log(String(handle.pid))
        `,
      )
      const pid = Number(printed.stdout.trim())

      // the parent came back while the child was still sleeping — it did not wait for it
      expect(printed.code).toBe(0)
      expect(pid).toBeGreaterThan(0)
      expect(await exists(marker)).toBe(false)

      const observed = await run(function* () {
        yield* BunIO.use()

        const orphanAlive = yield* IO.actions.processAlive(pid)

        while (!(yield* IO.actions.exists(marker))) {
          yield* sleep(100)
        }

        // reaped by init once it exited — give the reparenting a moment
        let aliveAfter = true

        for (let tries = 0; aliveAfter && tries < 50; tries += 1) {
          aliveAfter = yield* IO.actions.processAlive(pid)

          if (aliveAfter) {
            yield* sleep(100)
          }
        }

        return { orphanAlive, aliveAfter, wrote: yield* IO.actions.readText(marker) }
      })

      expect(unwrap(observed)).toEqual({ orphanAlive: true, aliveAfter: false, wrote: 'done\n' })
    })
  }, 20_000)

  it('after detach() the piped flows end, write fails, exited() still answers', async () => {
    const outcome = await run(function* () {
      yield* impl.use()

      // a child that printed after the detach would get EPIPE (the parent's pipe end is gone)
      const handle = yield* IO.actions.spawn('sh', ['-c', 'sleep 0.2; exit 5'])

      yield* handle.detach()

      const first = yield* (yield* handle.stdout).next()
      const errFirst = yield* (yield* handle.stderr).next()
      const written = yield* attempt(() => handle.write('x'))
      const status = yield* handle.exited()

      return {
        stdout: first.done === true ? first.value : 'had-data',
        stderr: errFirst.done === true ? errFirst.value : 'had-data',
        write: errorOf(written),
        code: status.code,
      }
    })

    expect(unwrap(outcome)).toEqual({
      stdout: true,
      stderr: true,
      write: IOErrors.StdinWriteFailed,
      code: 5,
    })
  })
})
