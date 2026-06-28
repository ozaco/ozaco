import type { PromptDef } from 'cli:core'
import { operation } from 'std:effect'

import { readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

import type { FieldState, PathEntry, PromptSpec } from '../../types'
import { cancelledLine, inlineFrame, submittedLine } from '../chrome'
import { createInput, editLine, renderInput } from '../edit'
import { runPrompt } from '../engine'
import { isEnter, isTab } from '../keys'

const MAX_CANDIDATES = 8

const longestCommonPrefix = (items: readonly string[]): string => {
  if (items.length === 0) {
    return ''
  }

  let prefix = items[0]!
  for (const item of items) {
    while (!item.startsWith(prefix)) {
      prefix = prefix.slice(0, -1)
    }
  }
  return prefix
}

export const path = operation(function* (options: PromptDef.PathOptions) {
  const root = options.root ?? process.cwd()

  const scan = (value: string): { base: string; entries: PathEntry[] } => {
    const trailing = value === '' || value.endsWith('/')
    const absolute = isAbsolute(value) ? value : join(root, value)
    const dir = trailing ? absolute : dirname(absolute)
    const prefix = trailing ? '' : basename(absolute)
    const base = trailing ? value : value.slice(0, value.length - prefix.length)

    try {
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.name.startsWith(prefix))
        .filter(entry => !options.directory || entry.isDirectory())
        .map(entry => ({ name: entry.name, isDir: entry.isDirectory() }))
      return { base, entries }
    } catch {
      return { base, entries: [] }
    }
  }

  const complete = (value: string): string => {
    const { base, entries } = scan(value)
    if (entries.length === 0) {
      return value
    }

    let completed = base + longestCommonPrefix(entries.map(entry => entry.name))
    if (entries.length === 1 && entries[0]!.isDir && !completed.endsWith('/')) {
      completed += '/'
    }
    return completed
  }

  const spec: PromptSpec<FieldState, string> = {
    description: options.description,
    initial: { input: createInput(options.initial ?? '') },
    render: (state, ctx) => {
      const { colors } = ctx.palette
      const head = inlineFrame(ctx, options.message, {
        body: renderInput(state.input, ctx.palette, {
          placeholder: options.directory ? './' : 'path',
        }),
        error: state.error,
      })

      const { entries } = scan(state.input.value)
      if (entries.length === 0) {
        return head
      }

      const rows = entries
        .slice(0, MAX_CANDIDATES)
        .map(entry => (entry.isDir ? `  ${colors.primary(`${entry.name}/`)}` : `  ${entry.name}`))

      if (entries.length > MAX_CANDIDATES) {
        rows.push(`  ${colors.muted(`…and ${entries.length - MAX_CANDIDATES} more`)}`)
      }
      rows.push(`  ${colors.muted('Tab to complete')}`)

      return `${head}\n${rows.join('\n')}`
    },
    onKey: (state, key) => {
      if (isEnter(key)) {
        const value = state.input.value
        const error = options.validate?.(value)
        return error === undefined
          ? { type: 'submit', value }
          : { type: 'update', state: { ...state, error } }
      }

      if (isTab(key)) {
        return { type: 'update', state: { input: createInput(complete(state.input.value)) } }
      }

      const input = editLine(state.input, key)
      return input === undefined ? undefined : { type: 'update', state: { input } }
    },
    submitted: (value, _state, ctx) => submittedLine(ctx, options.message, value),
    cancelled: (_state, ctx) => cancelledLine(ctx, options.message),
    *fallback() {
      return options.initial ?? ''
    },
  }

  return yield* runPrompt(spec)
})
