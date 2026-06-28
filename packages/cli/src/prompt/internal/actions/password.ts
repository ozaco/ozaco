import type { PromptDef } from 'cli:core'
import { operation } from 'std:effect'

import type { FieldState, PromptSpec } from '../../types'
import { cancelledLine, inlineFrame, submittedLine } from '../chrome'
import { createInput, editLine, renderInput } from '../edit'
import { runPrompt } from '../engine'
import { isEnter } from '../keys'

export const password = operation(function* (options: PromptDef.PasswordOptions) {
  const mask = options.mask ?? '•'
  const echo = (value: string): string => (mask === '' ? '' : mask.repeat(value.length))

  const spec: PromptSpec<FieldState, string> = {
    description: options.description,
    initial: { input: createInput() },
    render: (state, ctx) =>
      inlineFrame(ctx, options.message, {
        body: renderInput(state.input, ctx.palette, { mask }),
        error: state.error,
      }),
    onKey: (state, key) => {
      if (isEnter(key)) {
        const value = state.input.value
        const error = options.validate?.(value)
        return error === undefined
          ? { type: 'submit', value }
          : { type: 'update', state: { ...state, error } }
      }

      const input = editLine(state.input, key)
      return input === undefined ? undefined : { type: 'update', state: { input } }
    },
    submitted: (value, _state, ctx) => submittedLine(ctx, options.message, echo(value)),
    cancelled: (_state, ctx) => cancelledLine(ctx, options.message),
    *fallback() {
      return ''
    },
  }

  return yield* runPrompt(spec)
})
