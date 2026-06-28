import { operation } from 'std:effect'

import type { PromptDef } from 'cli:core'

import type { MultiSelectState, PromptSpec } from '../../types'
import { firstEnabled, indicesToValues, labelOf, resolveSelected } from '../choice'
import { activeLine, cancelledLine, hint, label, submittedLine } from '../chrome'
import { runPrompt } from '../engine'
import { isEnter, isDown, isSpace, isUp } from '../keys'
import { paginate, step } from '../list'

export const multiselect = operation(function* <T>(options: PromptDef.MultiSelectOptions<T>) {
  const choices = options.choices
  const disabled = (index: number): boolean => Boolean(choices[index]?.disabled)

  const check = (selected: ReadonlySet<number>): string | undefined => {
    const count = selected.size
    if ((options.required ?? false) && count === 0) {
      return 'Select at least one option'
    }
    if (options.min !== undefined && count < options.min) {
      return `Select at least ${options.min}`
    }
    if (options.max !== undefined && count > options.max) {
      return `Select at most ${options.max}`
    }
    return undefined
  }

  const spec: PromptSpec<MultiSelectState, T[]> = {
    description: options.description,
    initial: {
      cursor: firstEnabled(choices),
      selected: resolveSelected(options.initial, choices),
    },
    render: (state, ctx) => {
      const { colors, symbols } = ctx.palette
      const page = paginate(choices, state.cursor, 10)

      const rows = page.items.map((choice, offset) => {
        const index = page.start + offset
        const on = state.selected.has(index)
        const box = on ? colors.success(symbols.checkboxOn) : colors.muted(symbols.checkboxOff)
        const pointer = index === state.cursor ? colors.bold(colors.primary(symbols.pointer)) : ' '
        const text = label(choice)
        const note = choice.hint ? ` ${colors.muted(choice.hint)}` : ''

        if (choice.disabled) {
          return `${pointer} ${box} ${colors.muted(colors.strikethrough(text))}`
        }
        const painted = index === state.cursor ? colors.bold(colors.primary(text)) : text
        return `${pointer} ${box} ${painted}${note}`
      })

      const head = `${activeLine(ctx, options.message)} ${hint(ctx, '(space, enter)')}`
      const body = `${head}\n${rows.join('\n')}`
      return state.error === undefined ? body : `${body}\n${colors.error(state.error)}`
    },
    onKey: (state, key) => {
      if (isUp(key)) {
        return {
          type: 'update',
          state: {
            ...state,
            cursor: step(state.cursor, -1, { length: choices.length, disabled }),
            error: undefined,
          },
        }
      }
      if (isDown(key)) {
        return {
          type: 'update',
          state: {
            ...state,
            cursor: step(state.cursor, 1, { length: choices.length, disabled }),
            error: undefined,
          },
        }
      }
      if (isSpace(key)) {
        const choice = choices[state.cursor]
        if (!choice || choice.disabled) {
          return undefined
        }
        const selected = new Set(state.selected)
        if (selected.has(state.cursor)) {
          selected.delete(state.cursor)
        } else {
          selected.add(state.cursor)
        }
        return { type: 'update', state: { ...state, selected, error: undefined } }
      }
      if (isEnter(key)) {
        const error = check(state.selected)
        return error === undefined
          ? { type: 'submit', value: indicesToValues(state.selected, choices) }
          : { type: 'update', state: { ...state, error } }
      }
      return undefined
    },
    submitted: (values, _state, ctx) => {
      const text = values.map(value => labelOf(value, choices)).join(', ')
      return submittedLine(ctx, options.message, text === '' ? 'none' : text)
    },
    cancelled: (_state, ctx) => cancelledLine(ctx, options.message),
    *fallback() {
      return indicesToValues(resolveSelected(options.initial, choices), choices)
    },
  }

  return yield* runPrompt(spec)
})
