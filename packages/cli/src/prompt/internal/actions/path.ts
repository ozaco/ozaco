import type { Operation } from 'std:effect'
import { attempt, operation } from 'std:effect'
import { IO } from 'std:io'
import { isSuccess } from 'std:result'

import type { PathState } from '../../types/internal'
import type { PromptDef, PromptSpec } from '../../types/prompt'
import { runPrompt } from '../../utils'
import { cancelledLine, inlineFrame, submittedLine } from '../chrome'
import { createInput, editLine, renderInput } from '../edit'
import { isEnter, isTab } from '../keys'

const MAX_CANDIDATES = 8

/**
 * Default directory lister: one `IO.actions.walk(dir, { maxDepth: 1 })` through the installed
 * `std:io` protocol. A failure (missing dir, no IO installed) resolves to no suggestions — the
 * prompt itself keeps working. Runs from the engine's effectful `prepare` step, and only when the
 * input actually changed (never inside `render`).
 */
const defaultScan = (dir: string): Operation<PromptDef.PathEntry[]> =>
  operation(function* () {
    const walked = yield* attempt(IO.actions.walk(dir, { maxDepth: 1 }))
    if (!isSuccess(walked)) {
      return []
    }
    return walked.value
      .filter(entry => entry.path !== dir)
      .map(entry => ({ name: entry.name, isDir: entry.isDirectory }))
  })()

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

interface Split {
  /** The directory to list. */
  dir: string
  /** The typed leaf being completed. */
  prefix: string
  /** The input text up to (excluding) the leaf. */
  base: string
}

const splitValue = (value: string, root: string): Split => {
  const trailing = value === '' || value.endsWith('/')
  const absolute = value.startsWith('/') ? value : `${root.replace(/\/$/u, '')}/${value}`
  const dir = trailing ? absolute : absolute.slice(0, absolute.lastIndexOf('/') + 1)
  const prefix = trailing ? '' : value.slice(value.lastIndexOf('/') + 1)
  const base = trailing ? value : value.slice(0, value.length - prefix.length)
  return { dir: dir === '' ? '.' : dir, prefix, base }
}

export const path = operation(function* (options: PromptDef.PathOptions) {
  const root = options.root ?? '.'
  const scan = options.scan ?? defaultScan

  const matchesOf = (state: PathState): PromptDef.PathEntry[] => {
    const { prefix } = splitValue(state.input.value, root)
    return state.entries
      .filter(entry => entry.name.startsWith(prefix))
      .filter(entry => !options.directory || entry.isDir)
  }

  const complete = (state: PathState): string => {
    const value = state.input.value
    const matches = matchesOf(state)
    if (matches.length === 0) {
      return value
    }

    const { base } = splitValue(value, root)
    let completed = base + longestCommonPrefix(matches.map(entry => entry.name))
    if (matches.length === 1 && matches[0]!.isDir && !completed.endsWith('/')) {
      completed += '/'
    }
    return completed
  }

  const spec: PromptSpec<PathState, string> = {
    description: options.description,
    initial: { input: createInput(options.initial ?? ''), scanned: '\u0000', entries: [] },
    // lazy: rescan only when the input value actually changed since the last scan
    *prepare(state) {
      if (state.scanned === state.input.value) {
        return state
      }
      const { dir } = splitValue(state.input.value, root)
      const entries = yield* scan(dir)
      return { ...state, scanned: state.input.value, entries }
    },
    render: (state, ctx) => {
      const { colors } = ctx.palette
      const head = inlineFrame(ctx, options.message, {
        body: renderInput(state.input, ctx.palette, {
          placeholder: options.directory ? './' : 'path',
        }),
        error: state.error,
      })

      const matches = matchesOf(state)
      if (matches.length === 0) {
        return head
      }

      const rows = matches
        .slice(0, MAX_CANDIDATES)
        .map(entry => (entry.isDir ? `  ${colors.primary(`${entry.name}/`)}` : `  ${entry.name}`))

      if (matches.length > MAX_CANDIDATES) {
        rows.push(`  ${colors.muted(`…and ${matches.length - MAX_CANDIDATES} more`)}`)
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
        return { type: 'update', state: { ...state, input: createInput(complete(state)) } }
      }

      const input = editLine(state.input, key)
      return input === undefined ? undefined : { type: 'update', state: { ...state, input } }
    },
    submitted: (value, _state, ctx) => submittedLine(ctx, options.message, value),
    cancelled: (_state, ctx) => cancelledLine(ctx, options.message),
  }

  return yield* runPrompt(spec)
})
