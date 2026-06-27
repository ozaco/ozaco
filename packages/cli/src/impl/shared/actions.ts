import type { Operation } from 'std:effect'
import { createSignal, each, ensure, operation, scoped, spawn, useContext } from 'std:effect'
import { IO } from 'std:io'
import type { AnyType } from 'std:shared'

import { emitKeypressEvents } from 'node:readline'
import { PassThrough } from 'node:stream'

import type { Key } from 'cli:core'
import { ansi, KeyStreamContext, Terminal } from 'cli:core'

const encoder = new TextEncoder()

export const terminalWrite = operation(function* (text: string) {
  const ctx = yield* useContext(Terminal)
  ctx.output.write(text)
})

export const terminalSession = operation(function* <R, E>(fn: () => Operation<R, E>) {
  const ctx = yield* useContext(Terminal)

  return yield* scoped<R, unknown>(function* () {
    const signal = createSignal<Key, void>()

    if (ctx.interactive) {
      ctx.input.setRawMode?.(true)
      ctx.output.write(ansi.hideCursor)
    }

    // readline owns the byte→keypress decoding; we feed it through an effect stream below.
    const through = new PassThrough()
    through.setEncoding(ctx.encoding)
    emitKeypressEvents(through)

    const onKeypress = (str: string | undefined, key: AnyType) => {
      const sequence = key?.sequence ?? str ?? ''
      signal.send({
        name: key?.name ?? 'unknown',
        sequence,
        ctrl: key?.ctrl ?? false,
        meta: key?.meta ?? false,
        shift: key?.shift ?? false,
        raw: encoder.encode(sequence),
      })
    }
    through.on('keypress', onKeypress)

    yield* ensure(function* () {
      through.off('keypress', onKeypress)
      signal.close()
      through.end()
      through.destroy()
      if (ctx.interactive) {
        ctx.output.write(ansi.showCursor)
        ctx.input.setRawMode?.(false)
      }
    })

    yield* spawn(function* () {
      const stream = IO.actions.fromReadable(ctx.input, { destroy: false })

      for (const chunk of yield* each(stream)) {
        if (through.writable) {
          through.write(chunk)
        }
        yield* each.next()
      }
    })

    yield* KeyStreamContext.set(signal)

    return yield* fn()
  })
})

export const terminalKeys = operation(function* () {
  return yield* KeyStreamContext.expect()
})
