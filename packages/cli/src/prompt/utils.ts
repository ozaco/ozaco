import { CliErrors, Terminal, useTerminal } from 'cli:core'
import type { Key } from 'cli:core'
import { usePalette } from 'cli:palette'
import type { Operation } from 'std:effect'
import { each } from 'std:effect'
import { fail } from 'std:result'

import type { PromptContext, PromptSpec } from './types/prompt'

const isCancelKey = (key: Key): boolean =>
  key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))

/**
 * Run one prompt to completion: a raw-mode `session` around a render-lease loop over the decoded
 * key flow. Cancel (ctrl+c / ctrl+d / esc) fails `cli.cancelled`; a non-interactive terminal fails
 * `cli.not-interactive` before anything is drawn.
 */
export function* runPrompt<S, V>(spec: PromptSpec<S, V>): Operation<V> {
  const info = yield* useTerminal()
  const palette = yield* usePalette()

  if (!info.capabilities.interactive) {
    return yield* fail(CliErrors.NotInteractive, 'prompt requires an interactive terminal')
  }

  const { columns } = yield* Terminal.actions.size()
  const ctx: PromptContext = { palette, columns }

  return yield* Terminal.actions.session(function* () {
    const keys = yield* Terminal.actions.keys()
    const lease = yield* Terminal.actions.renderer()

    const paint = (current: S): string => {
      const frame = spec.render(current, ctx)
      if (spec.description === undefined) {
        return frame
      }
      return `${frame}\n  ${ctx.palette.colors.muted(spec.description)}`
    }

    let state = spec.initial
    if (spec.prepare) {
      state = yield* spec.prepare(state, ctx)
    }
    yield* lease.render(paint(state))

    for (const key of yield* each(keys)) {
      if (isCancelKey(key)) {
        yield* lease.done(spec.cancelled(state, ctx))
        return yield* fail(CliErrors.Cancelled, 'prompt cancelled')
      }

      const action = spec.onKey(state, key, ctx)

      if (action?.type === 'cancel') {
        yield* lease.done(spec.cancelled(state, ctx))
        return yield* fail(CliErrors.Cancelled, 'prompt cancelled')
      }

      if (action?.type === 'submit') {
        yield* lease.done(spec.submitted(action.value, state, ctx))
        return action.value
      }

      if (action?.type === 'update') {
        state = action.state
        if (spec.prepare) {
          state = yield* spec.prepare(state, ctx)
        }
        yield* lease.render(paint(state))
      }

      yield* each.next()
    }

    return yield* fail(CliErrors.Cancelled, 'input stream closed')
  })
}
