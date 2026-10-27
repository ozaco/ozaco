import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * `main(body, options)`: extra stop signals with their statuses, a teardown deadline, and what an
 * unhandled rejection does — observed from the outside like `main.test.ts` does (a subprocess).
 */

const EFFECT_ENTRY = resolve(import.meta.dir, '../../src/effect/index.ts')

const program = `
import { main, sleep, suspend } from ${JSON.stringify(EFFECT_ENTRY)}

await main(
  function* (args) {
    if (args[0] === 'reject') {
      setTimeout(() => { void Promise.reject(new Error('late boom')) }, 20)
    }
    try {
      process.stdout.write('running\\n')
      yield* suspend()
    } finally {
      if (args[0] === 'slow-teardown') {
        yield* sleep(2000)
      }
      process.stdout.write('teardown\\n')
    }
  },
  { signals: { SIGTERM: 0, SIGHUP: 0 }, deadlineMs: 150, unhandledRejection: 'log' },
)
`

let dir = ''
let script = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ozaco-main-options-'))
  script = join(dir, 'program.ts')
  await writeFile(script, program)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const launch = (...args: string[]) => {
  const proc = Bun.spawn([process.execPath, 'run', script, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: dir,
    env: { ...process.env, NO_COLOR: '1' },
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

    running.resolve()

    return stdout
  })()

  return {
    proc,
    running: running.promise,
    finish: async () => {
      const [status, output, stderr] = await Promise.all([
        proc.exited,
        collected,
        new Response(proc.stderr).text(),
      ])

      return { status, output, stderr }
    },
  }
}

const skip = process.platform === 'win32'

describe('main options', () => {
  it.skipIf(skip)('an added signal shuts down gracefully with its own status', async () => {
    const { proc, running, finish } = launch()

    await running
    proc.kill('SIGHUP')

    const { status, output } = await finish()

    expect(status).toBe(0)
    expect(output).toContain('teardown')
  })

  it.skipIf(skip)('a teardown past deadlineMs is ended hard with the signal status', async () => {
    const { proc, running, finish } = launch('slow-teardown')

    await running

    const started = Date.now()

    proc.kill('SIGTERM')

    const { status, output } = await finish()

    expect(status).toBe(0)
    expect(output).not.toContain('teardown')
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it.skipIf(skip)(
    "unhandledRejection: 'log' prints the chain and keeps the program alive",
    async () => {
      const { proc, running, finish } = launch('reject')

      await running
      await Bun.sleep(120)
      proc.kill('SIGTERM')

      const { status, output, stderr } = await finish()

      expect(status).toBe(0)
      expect(output).toContain('teardown')
      expect(stderr).toContain('late boom')
    },
  )
})
