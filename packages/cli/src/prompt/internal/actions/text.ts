import { operation } from 'std:effect'

import type { Helpers } from '../../types/helpers'
import type { PromptDef, PromptSpec } from '../../types/prompt'
import { runPrompt } from '../../utils'
import { cancelledLine, inlineFrame, submittedLine } from '../chrome'
import { createInput, editLine, renderInput } from '../edit'
import { isEnter } from '../keys'

export const text = operation(function* (options: PromptDef.TextOptions) {
  const spec: PromptSpec<Helpers.FieldState, string> = {
    description: options.description,
    initial: { input: createInput(options.initial ?? '') },
    render: (state, ctx) =>
      inlineFrame(ctx, options.message, {
        body: renderInput(state.input, ctx.palette, { placeholder: options.placeholder }),
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
    submitted: (value, _state, ctx) => submittedLine(ctx, options.message, value),
    cancelled: (_state, ctx) => cancelledLine(ctx, options.message),
  }

  return yield* runPrompt(spec)
})
