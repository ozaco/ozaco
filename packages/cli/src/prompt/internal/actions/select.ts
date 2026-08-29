import { operation } from 'std:effect'

import type { Helpers } from '../../types/helpers'
import type { PromptDef, PromptSpec } from '../../types/prompt'
import { runPrompt } from '../../utils'
import { labelOf, resolveIndex } from '../choice'
import { activeLine, cancelledLine, hint, label, submittedLine } from '../chrome'
import { isEnter, isDown, isUp } from '../keys'
import { paginate, step } from '../list'

export const select = operation(function* <T>(options: PromptDef.SelectOptions<T>) {
  const choices = options.choices
  const disabled = (index: number): boolean => Boolean(choices[index]?.disabled)
  const initial = resolveIndex(options.initial, choices)

  const spec: PromptSpec<Helpers.SelectState, T> = {
    description: options.description,
    initial: { active: initial },
    render: (state, ctx) => {
      const { colors, symbols } = ctx.palette
      const page = paginate(choices, state.active, 10)

      const rows = page.items.map((choice, offset) => {
        const index = page.start + offset
        const text = label(choice)
        const note = choice.hint ? ` ${colors.muted(choice.hint)}` : ''

        if (choice.disabled) {
          return `  ${colors.muted(colors.strikethrough(text))}`
        }
        return index === state.active
          ? `${colors.bold(colors.primary(symbols.pointer))} ${colors.bold(colors.primary(text))}${note}`
          : `  ${text}${note}`
      })

      return `${activeLine(ctx, options.message)} ${hint(ctx, '(↑/↓, enter)')}\n${rows.join('\n')}`
    },
    onKey: (state, key) => {
      if (isUp(key)) {
        return {
          type: 'update',
          state: { active: step(state.active, -1, { length: choices.length, disabled }) },
        }
      }
      if (isDown(key)) {
        return {
          type: 'update',
          state: { active: step(state.active, 1, { length: choices.length, disabled }) },
        }
      }
      if (isEnter(key)) {
        const choice = choices[state.active]
        return !choice || choice.disabled ? undefined : { type: 'submit', value: choice.value }
      }
      return undefined
    },
    submitted: (value, _state, ctx) => submittedLine(ctx, options.message, labelOf(value, choices)),
    cancelled: (_state, ctx) => cancelledLine(ctx, options.message),
  }

  return yield* runPrompt(spec)
})
