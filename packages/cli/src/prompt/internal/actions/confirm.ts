import { operation } from 'std:effect'

import type { Helpers } from '../../types/helpers'
import type { PromptDef, PromptSpec } from '../../types/prompt'
import { runPrompt } from '../../utils'
import { activeLine, cancelledLine, hint, submittedLine } from '../chrome'
import { isEnter, isSpace } from '../keys'

export const confirm = operation(function* (options: PromptDef.ConfirmOptions) {
  const initial = options.initial ?? false

  const spec: PromptSpec<Helpers.ConfirmState, boolean> = {
    description: options.description,
    initial: { value: initial },
    render: (state, ctx) =>
      `${activeLine(ctx, options.message)} ${hint(ctx, state.value ? '(Y/n)' : '(y/N)')}`,
    onKey: (state, key) => {
      if (isEnter(key)) {
        return { type: 'submit', value: state.value }
      }

      const seq = key.sequence.toLowerCase()
      if (seq === 'y') {
        return { type: 'submit', value: true }
      }
      if (seq === 'n') {
        return { type: 'submit', value: false }
      }

      if (key.name === 'left' || key.name === 'right' || key.name === 'tab' || isSpace(key)) {
        return { type: 'update', state: { value: !state.value } }
      }

      return undefined
    },
    submitted: (value, _state, ctx) => submittedLine(ctx, options.message, value ? 'yes' : 'no'),
    cancelled: (_state, ctx) => cancelledLine(ctx, options.message),
  }

  return yield* runPrompt(spec)
})
