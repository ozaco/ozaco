import type { Operation } from 'std:effect'
import { each, useContext } from 'std:effect'
import { fail } from 'std:result'

import type { Key } from 'cli:core'
import { CoreErrors, Palette, Terminal } from 'cli:core'

import type { PromptContext, PromptSpec } from '../types'

const isCancelKey = (key: Key): boolean =>
  key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))

export function* runPrompt<S, V>(spec: PromptSpec<S, V>): Operation<V, unknown> {
  const terminal = yield* useContext(Terminal)
  const palette = yield* useContext(Palette)
  const { columns } = yield* Terminal.actions.size()
  const ctx: PromptContext = { palette, columns }

  if (!terminal.interactive) {
    if (spec.fallback) {
      return yield* spec.fallback(ctx)
    }
    return yield* fail(CoreErrors.NotInteractive, 'prompt requires an interactive terminal')
  }

  return yield* Terminal.actions.session(function* () {
    const keys = yield* Terminal.actions.keys()
    const renderer = yield* Terminal.actions.renderer(columns)

    const paint = (current: S): string => {
      const frame = spec.render(current, ctx)
      if (spec.description === undefined) {
        return frame
      }
      return `${frame}\n  ${ctx.palette.colors.muted(spec.description)}`
    }

    let state = spec.initial
    yield* renderer.render(paint(state))

    for (const key of yield* each(keys)) {
      if (isCancelKey(key)) {
        yield* renderer.done(spec.cancelled(state, ctx))
        return yield* fail(CoreErrors.Cancelled, 'prompt cancelled')
      }

      const action = spec.onKey(state, key, ctx)

      if (action?.type === 'cancel') {
        yield* renderer.done(spec.cancelled(state, ctx))
        return yield* fail(CoreErrors.Cancelled, 'prompt cancelled')
      }

      if (action?.type === 'submit') {
        yield* renderer.done(spec.submitted(action.value, state, ctx))
        return action.value
      }

      if (action?.type === 'update') {
        state = action.state
        yield* renderer.render(paint(state))
      }

      yield* each.next()
    }

    return yield* fail(CoreErrors.Cancelled, 'input stream closed')
  })
}
