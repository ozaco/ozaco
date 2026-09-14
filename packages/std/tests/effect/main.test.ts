import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * AUDIT E41: `main` (utils/main.ts) wires SIGINT/SIGTERM into a graceful shutdown and exits with
 * the resulting status, but nothing tested it. `main` ends in `process.exit`, so it can only be
 * observed from the outside: each case spawns a Bun subprocess running a tiny program built on
 * `main`, waits for the program to announce it is running, sends the signal, and asserts the
 * exit status AND that the body's `finally` ran (graceful, not a hard kill).
 *
 * DEVIATION PINNED (AUDIT E3): the node branch removes the SIGTERM listener with the SIGINT
 * handler (`process.off('SIGTERM', interrupt.SIGINT)`), so the real SIGTERM listener leaks past
 * `main`'s teardown. The `listener symmetry` case asserts the leaked count as it is today — it
 * will FAIL once E3 is fixed, which is the signal to flip it to `SIGTERM=0`.
 */

const EFFECT_ENTRY = resolve(import.meta.dir, '../../src/effect/index.ts')

const program = `
import { main, sleep, suspend } from ${JSON.stringify(EFFECT_ENTRY)}

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

  it.skipIf(skip)(
    'DEVIATION (E3): listener symmetry — SIGINT is detached, SIGTERM leaks',
    async () => {
      const { finish } = launch('exit-now')

      const { output } = await finish()

      // the SIGINT listener is removed on the way out; the SIGTERM one is not (E3 — `process.off`
      // is handed the SIGINT handler). Expected after the fix: `SIGINT=0 SIGTERM=0`.
      expect(output).toContain('listeners SIGINT=0 SIGTERM=1')
    },
  )
})
