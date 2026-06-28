import { operation } from 'std:effect'

import type { PromptDef } from 'cli:core'

import type { FieldState, NumberParsed, PromptSpec } from '../../types'
import { cancelledLine, inlineFrame, submittedLine } from '../chrome'
import { createInput, editLine, isPrintable, renderInput } from '../edit'
import { runPrompt } from '../engine'
import { isEnter } from '../keys'

export const number = operation(function* (options: PromptDef.NumberOptions) {
  const allowed = options.float ? /[-0-9.]/u : /[-0-9]/u

  const parse = (raw: string): NumberParsed => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      return { error: 'Please enter a number' }
    }

    const value = Number(trimmed)
    if (Number.isNaN(value)) {
      return { error: 'Please enter a valid number' }
    }
    if (!options.float && !Number.isInteger(value)) {
      return { error: 'Please enter a whole number' }
    }
    if (options.min !== undefined && value < options.min) {
      return { error: `Must be at least ${options.min}` }
    }
    if (options.max !== undefined && value > options.max) {
      return { error: `Must be at most ${options.max}` }
    }

    const custom = options.validate?.(value)
    return custom === undefined ? { value } : { error: custom }
  }

  const spec: PromptSpec<FieldState, number> = {
    description: options.description,
    initial: {
      input: createInput(options.initial === undefined ? '' : String(options.initial)),
    },
    render: (state, ctx) =>
      inlineFrame(ctx, options.message, {
        body: renderInput(state.input, ctx.palette, { placeholder: '0' }),
        error: state.error,
      }),
    onKey: (state, key) => {
      if (isEnter(key)) {
        const { value, error } = parse(state.input.value)
        return error === undefined
          ? { type: 'submit', value: value! }
          : { type: 'update', state: { ...state, error } }
      }

      if (isPrintable(key) && !allowed.test(key.sequence)) {
        return undefined
      }

      const input = editLine(state.input, key)
      return input === undefined ? undefined : { type: 'update', state: { input } }
    },
    submitted: (value, _state, ctx) => submittedLine(ctx, options.message, String(value)),
    cancelled: (_state, ctx) => cancelledLine(ctx, options.message),
    *fallback() {
      return options.initial ?? 0
    },
  }

  return yield* runPrompt(spec)
})
