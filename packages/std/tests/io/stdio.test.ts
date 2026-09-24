import type { Flow } from 'std:effect'
import { attempt, flowOf, run } from 'std:effect'
import { IO, decodeText } from 'std:io'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunIO } from 'std:io/impl/bun'
import { NodeIO } from 'std:io/impl/node'
import { WebIO } from 'std:io/impl/web'

const decoder = new TextDecoder()
const SRC = join(import.meta.dir, '../../src')

/** Run `body` as a standalone Bun script (std imported from source) and capture what it printed —
 * the only way to observe bytes that went to the REAL terminal streams. */
const runScript = async (body: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'ozaco-stdio-'))
  try {
    const file = join(dir, 'script.ts')
    await writeFile(
      file,
      [
        `import { flowOf, run } from '${SRC}/effect/index.ts'`,
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
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Split `text`'s bytes so every chunk boundary cuts a multi-byte character in half. */
const splitBytes = (text: string, size: number): Uint8Array[] => {
  const bytes = new TextEncoder().encode(text)
  const chunks: Uint8Array[] = []
  for (let at = 0; at < bytes.length; at += size) {
    chunks.push(bytes.slice(at, at + size))
  }
  return chunks
}

const bytesFlow = (chunks: Uint8Array[]): Flow<Uint8Array, true> =>
  flowOf<Uint8Array, true>(function* (emit) {
    for (const chunk of chunks) {
      yield* emit(chunk)
    }
    return true
  })

describe('spawn stdio', () => {
  it.each([
    ['BunIO', 'BunIO'],
    ['NodeIO', 'NodeIO'],
  ])("%s: stdio 'inherit' hands the child the parent's terminal streams", async (_, impl) => {
    const printed = await runScript(`
      yield* ${impl}.use()
      const handle = yield* IO.actions.spawn('sh', ['-c', 'printf inherited-out; printf inherited-err >&2'], { stdio: 'inherit' })
      yield* handle.exited()
    `)

    expect(printed).toEqual({ stdout: 'inherited-out', stderr: 'inherited-err', code: 0 })
  })

  it.each([
    ['BunIO', BunIO],
    ['NodeIO', NodeIO],
  ] as const)('%s: an inherited stream is an empty flow; stdin write fails', async (_, impl) => {
    const outcome = await run(function* () {
      yield* impl.use()

      const handle = yield* IO.actions.spawn('true', [], { stdio: 'inherit' })
      const out = yield* handle.stdout
      const first = yield* out.next()
      const err = yield* handle.stderr
      const errFirst = yield* err.next()

      const written = yield* attempt(() => handle.write('nope'))
      yield* handle.closeStdin()
      const status = yield* handle.exited()

      return {
        stdout: first.done === true ? first.value : 'had-data',
        stderr: errFirst.done === true ? errFirst.value : 'had-data',
        write: isFailure(written) ? written.error : 'no-failure',
        success: status.success,
      }
    })

    expect(unwrap(outcome)).toEqual({
      stdout: true,
      stderr: true,
      write: 'std:io.stdin-write-failed',
      success: true,
    })
  })

  it.each([
    ['BunIO', BunIO],
    ['NodeIO', NodeIO],
  ] as const)('%s: stdio per stream — only the named stream is inherited', async (_, impl) => {
    const outcome = await run(function* () {
      yield* impl.use()

      const handle = yield* IO.actions.spawn(
        'sh',
        ['-c', 'read line; printf "err:%s" "$line" >&2'],
        {
          stdio: { stdout: 'inherit' },
        },
      )
      yield* handle.write('piped\n')
      yield* handle.closeStdin()

      const err = yield* handle.stderr
      let text = ''
      while (true) {
        const item = yield* err.next()
        if (item.done) {
          break
        }
        text += decoder.decode(item.value)
      }

      const out = yield* handle.stdout
      const outFirst = yield* out.next()
      yield* handle.exited()

      return { stderr: text, stdoutEmpty: outFirst.done === true }
    })

    expect(unwrap(outcome)).toEqual({ stderr: 'err:piped', stdoutEmpty: true })
  })
})

describe('decodeText', () => {
  it('decodes multi-byte characters split across chunks', async () => {
    const text = 'héllo — 日本語 🎉 done'
    const outcome = await run(function* () {
      const subscription = yield* decodeText(bytesFlow(splitBytes(text, 1)))
      let decoded = ''
      while (true) {
        const item = yield* subscription.next()
        if (item.done) {
          return { decoded, close: item.value }
        }
        decoded += item.value
      }
    })

    expect(unwrap(outcome)).toEqual({ decoded: text, close: true })
  })
})

describe('toTerminal', () => {
  it.each(['BunIO', 'NodeIO'])('%s: writes the raw bytes to stdout / stderr', async impl => {
    const printed = await runScript(`
      yield* ${impl}.use()
      const bytes = new TextEncoder().encode('çok güzel 🎉')
      const chunked = flowOf(function* (emit) {
        for (let at = 0; at < bytes.length; at += 3) yield* emit(bytes.slice(at, at + 3))
        return true
      })
      yield* IO.actions.toTerminal(chunked)
      yield* IO.actions.toTerminal(flowOf(function* (emit) { yield* emit(new TextEncoder().encode('to-err')); return true }), { stream: 'stderr' })
    `)

    expect(printed).toEqual({ stdout: 'çok güzel 🎉', stderr: 'to-err', code: 0 })
  })

  it('raises the failure a source closes with, after writing what came before', async () => {
    const outcome = await run(function* () {
      yield* WebIO.use()
      const logged: string[] = []
      const original = console.log
      console.log = (line: string) => logged.push(line)
      try {
        const failing = flowOf<Uint8Array, never>(function* (emit) {
          yield* emit(new TextEncoder().encode('partial'))
          throw new Error('source broke')
        })
        const result = yield* attempt(() => IO.actions.toTerminal(failing))
        return { failed: isFailure(result), logged }
      } finally {
        console.log = original
      }
    })

    expect(unwrap(outcome)).toEqual({ failed: true, logged: ['partial'] })
  })

  it('WebIO logs whole decoded lines, flushing the trailing partial line', async () => {
    const outcome = await run(function* () {
      yield* WebIO.use()
      const logged: string[] = []
      const original = console.error
      console.error = (line: string) => logged.push(line)
      try {
        yield* IO.actions.toTerminal(bytesFlow(splitBytes('first ü\nsecond 🎉\nlast', 1)), {
          stream: 'stderr',
        })
      } finally {
        console.error = original
      }
      return logged
    })

    expect(unwrap(outcome)).toEqual(['first ü', 'second 🎉', 'last'])
  })
})
