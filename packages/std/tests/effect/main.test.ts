import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * `main` (utils/main.ts) wires SIGINT/SIGTERM into a graceful shutdown and exits with the
 * resulting status. `main` ends in `process.exit`, so it can only be
 * observed from the outside: each case spawns a Bun subprocess running a tiny program built on
 * `main`, waits for the program to announce it is running, sends the signal, and asserts the
 * exit status AND that the body's `finally` ran (graceful, not a hard kill).
 *
 * Listener symmetry: both signal listeners the node branch registers are detached on the way out
 * — the fixture prints `listeners SIGINT=<n> SIGTERM=<n>` at process exit.
 */

const EFFECT_ENTRY = resolve(import.meta.dir, '../../src/effect/index.ts')
const RESULT_ENTRY = resolve(import.meta.dir, '../../src/result/index.ts')

const program = `
import { main, sleep, suspend } from ${JSON.stringify(EFFECT_ENTRY)}
import { fail } from ${JSON.stringify(RESULT_ENTRY)}

process.on('exit', () => {
  process.stdout.write(
    'listeners SIGINT=' + process.listenerCount('SIGINT') +
    ' SIGTERM=' + process.listenerCount('SIGTERM') + '\\n',
  )
})

await main(function* (args) {
  if (args[0] === 'exit-now') {
    return
  }
  if (args[0] === 'fail') {
    const inner = fail('app.inner', 'inner boom')
    return yield* fail('app.failed', 'the app failed', 'booting', inner)
  }
  if (args[0] === 'throw') {
    throw new RangeError('raw boom')
  }
  if (args[0] === 'throw-value') {
    throw 'plain boom'
  }
  try {
    process.stdout.write('running\\n')
    yield* suspend()
  } finally {
    // an effectful teardown: a hard kill could never get here
    yield* sleep(5)
    process.stdout.write('teardown\\n')
  }
})
`

let dir = ''
let script = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ozaco-main-'))
  script = join(dir, 'program.ts')
  await writeFile(script, program)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Spawn the program; `running` settles once it printed `running` (or its stdout closed). */
const launch = (...args: string[]) => {
  const proc = Bun.spawn([process.execPath, 'run', script, ...args], {
    stdout: 'pipe',
    stderr: 'inherit',
    cwd: dir,
  })

  const running = Promise.withResolvers<void>()
  const decoder = new TextDecoder()

  const collected = (async () => {
    let stdout = ''

    for await (const chunk of proc.stdout) {
      stdout += decoder.decode(chunk, { stream: true })

      if (stdout.includes('running')) {
        running.resolve()
      }
    }

    // stdout closed without the marker: let a waiting test proceed to its assertions
    running.resolve()

    return stdout
  })()

  return {
    proc,
    running: running.promise,
    finish: async () => {
      const status = await proc.exited
      const output = await collected

      return { status, output }
    },
  }
}

const skip = process.platform === 'win32'

/**
 * The environment the program runs with: colours OFF. Bun paints `console.error` red whenever
 * colours are forced on it, and a launcher started from a terminal (moon, proto) hands its
 * tasks `FORCE_COLOR` / `CLICOLOR_FORCE` — the assertions below compare the TEXT `main` prints,
 * not the terminal's styling of it.
 */
const plainEnv = (): Record<string, string | undefined> => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !COLOR_FORCING.has(key))),
  NO_COLOR: '1',
})

const COLOR_FORCING: ReadonlySet<string> = new Set(['FORCE_COLOR', 'CLICOLOR_FORCE', 'CLICOLOR'])

/** Run the program to completion with stderr captured. */
const runCaptured = async (...args: string[]) => {
  const proc = Bun.spawn([process.execPath, 'run', script, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: dir,
    env: plainEnv(),
  })
  const [status, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])

  return { status, stderr }
}

describe('main signal wiring', () => {
  it.skipIf(skip)('SIGTERM shuts the body down gracefully and exits 143', async () => {
    const { proc, running, finish } = launch()

    await running

    proc.kill('SIGTERM')

    const { status, output } = await finish()

    expect(status).toBe(143)
    expect(output).toContain('teardown')
  })

  it.skipIf(skip)('SIGINT shuts the body down gracefully and exits 130', async () => {
    const { proc, running, finish } = launch()

    await running

    proc.kill('SIGINT')

    const { status, output } = await finish()

    expect(status).toBe(130)
    expect(output).toContain('teardown')
  })

  it.skipIf(skip)('a body that returns exits 0', async () => {
    const { finish } = launch('exit-now')

    const { status, output } = await finish()

    expect(status).toBe(0)
    expect(output).not.toContain('teardown')
  })

  it.skipIf(skip)('listener symmetry — SIGINT and SIGTERM are both detached on exit', async () => {
    const { finish } = launch('exit-now')

    const { output } = await finish()

    expect(output).toContain('listeners SIGINT=0 SIGTERM=0')
  })

  it.skipIf(skip)('a failing body exits 1 and prints the whole cause chain to stderr', async () => {
    const { status, stderr } = await runCaptured('fail')

    expect(status).toBe(1)
    expect(stderr.trimEnd().split('\n')).toEqual([
      'app.failed: the app failed',
      '    at booting',
      'Caused by: app.inner: inner boom',
    ])
  })

  it.skipIf(skip)('a thrown Error prints as its asFailure fold — no JS stack', async () => {
    const { status, stderr } = await runCaptured('throw')

    expect(status).toBe(1)
    expect(stderr.trimEnd()).toBe('std:result.unknown: RangeError: raw boom')
  })

  it.skipIf(skip)('a thrown non-Error value prints as its fold too', async () => {
    const { status, stderr } = await runCaptured('throw-value')

    expect(status).toBe(1)
    expect(stderr.trimEnd()).toBe('std:result.unknown: plain boom')
  })
})
