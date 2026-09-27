import type { Result } from 'std:result'
import { isFailure } from 'std:result'
import { serializeError } from 'std:shared'

import { CliCauses } from './errors'
import { ANSI_PATTERN } from './internal/const'
import { causeText } from './internal/failure'
import { hardBreak } from './internal/wrap'
import type { WrapOptions } from './types/common'

/** Strip ANSI escape sequences from a string (so display width can be measured). */
export const stripAnsi = (input: string): string => input.replace(ANSI_PATTERN, '')

/**
 * Visible width of a string in terminal cells: ANSI codes stripped, counted by code point (no
 * East-Asian widening). The ONE width function every module measures with — measuring styled text
 * without stripping is what used to misalign tables.
 */
export const displayWidth = (text: string): number => {
  let width = 0

  for (const _ of stripAnsi(text)) {
    width += 1
  }

  return width
}

/**
 * Word-wrap `text` to `columns`, ANSI-aware: escape sequences are preserved and never counted or
 * split. Wrapping happens at spaces; with `hard: true` a word wider than a line is broken at the
 * column boundary (never inside an escape sequence).
 */
export const wrapAnsi = (text: string, columns: number, options: WrapOptions = {}): string => {
  const limit = Math.max(1, columns)
  const out: string[] = []

  for (const line of text.split('\n')) {
    const words = line.split(' ').flatMap(word => {
      if (options.hard && displayWidth(word) > limit) {
        return hardBreak(word, limit)
      }
      return [word]
    })

    let current = ''
    for (const word of words) {
      if (current === '') {
        current = word
        continue
      }
      if (displayWidth(current) + 1 + displayWidth(word) <= limit) {
        current += ` ${word}`
      } else {
        out.push(current)
        current = word
      }
    }
    out.push(current)
  }

  return out.join('\n')
}

/** Whether `value` is a failure the cli already rendered (it carries `CliCauses.Reported`). */
export const isReported = (value: unknown): boolean =>
  isFailure(value) && value.causes.includes(CliCauses.Reported)

/**
 * A failure as one short, human-readable block: `tag: message`, then its causes (deduplicated,
 * the `reported` marker left out, a nested failure inline) on one indented line — never a
 * serialized object dump.
 */
export const describeFailure = (failure: Result.Failure<unknown>): string => {
  const tag = typeof failure.error === 'string' ? failure.error : serializeError(failure.error)
  const head = failure.message === '' ? tag : `${tag}: ${failure.message}`
  const causes = [...new Set<unknown>(failure.causes)]
    .filter(cause => cause !== CliCauses.Reported)
    .map(cause => causeText(cause))

  return causes.length === 0 ? head : `${head}\n  causes: ${causes.join(' › ')}`
}
