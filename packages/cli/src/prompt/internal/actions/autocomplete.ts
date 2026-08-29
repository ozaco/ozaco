import { operation } from 'std:effect'

import type { Helpers } from '../../types/helpers'
import type { PromptDef, PromptSpec } from '../../types/prompt'
import { runPrompt } from '../../utils'
import { labelOf } from '../choice'
import { activeLine, cancelledLine, hint, label, submittedLine } from '../chrome'
import { createInput, editLine, renderInput } from '../edit'
import { isEnter, isDown, isUp } from '../keys'
import { paginate, wrapIndex } from '../list'

export const autocomplete = operation(function* <T>(options: PromptDef.AutocompleteOptions<T>) {
  const defaultSuggest = (
    input: string,
    choices: readonly PromptDef.Choice<T>[],
  ): readonly PromptDef.Choice<T>[] => {
    const query = input.toLowerCase()
    return query === ''
      ? choices
      : choices.filter(choice => label(choice).toLowerCase().includes(query))
  }

  const suggest = options.suggest ?? defaultSuggest
  const match = (value: string): readonly PromptDef.Choice<T>[] => suggest(value, options.choices)

  const spec: PromptSpec<Helpers.AutocompleteState, T> = {
    description: options.description,
    initial: { input: createInput(), active: 0 },
    render: (state, ctx) => {
      const { colors, symbols } = ctx.palette
      const matches = match(state.input.value)
      const head = `${activeLine(ctx, options.message)} ${colors.primary(symbols.separator)} ${renderInput(state.input, ctx.palette, { placeholder: options.placeholder })}`

      if (matches.length === 0) {
        return `${head}\n  ${hint(ctx, 'no matches')}`
      }

      const page = paginate(matches, state.active, 8)
      const rows = page.items.map((choice, offset) => {
        const index = page.start + offset
        const text = label(choice)
        return index === state.active
          ? `${colors.bold(colors.primary(symbols.pointer))} ${colors.bold(colors.primary(text))}`
          : `  ${text}`
      })

      return `${head}\n${rows.join('\n')}`
    },
    onKey: (state, key) => {
      const matches = match(state.input.value)

      if (isUp(key)) {
        return {
          type: 'update',
          state: { ...state, active: wrapIndex(state.active - 1, matches.length) },
        }
      }
      if (isDown(key)) {
        return {
          type: 'update',
          state: { ...state, active: wrapIndex(state.active + 1, matches.length) },
        }
      }
      if (isEnter(key)) {
        const choice = matches[state.active]
        return !choice || choice.disabled ? undefined : { type: 'submit', value: choice.value }
      }

      const input = editLine(state.input, key)
      return input === undefined ? undefined : { type: 'update', state: { input, active: 0 } }
    },
    submitted: (value, _state, ctx) =>
      submittedLine(ctx, options.message, labelOf(value, options.choices)),
    cancelled: (_state, ctx) => cancelledLine(ctx, options.message),
  }

  return yield* runPrompt(spec)
})
