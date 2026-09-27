import type { ResultDef } from '../types/def'
import type { Result } from '../types/result'

import { byteLength, cutBytes } from './bytes'
import { levelOf, walk } from './chain'
import {
  CHAIN_DEPTH,
  CHAIN_LEVELS,
  CHAIN_MAX_BYTES,
  HEADER_BUDGET_BYTES,
  HEADER_MAX_BYTES,
} from './const'

const INDENT = '    '

const elision = (count: number): string => `${INDENT}... ${count} more`

const omission = (count: number): string =>
  `${INDENT}... ${count} more ${count === 1 ? 'level' : 'levels'}`

/** The cost of `line` once joined: its bytes plus the newline that separates it. */
const cost = (line: string): number => byteLength(line) + 1

/** A level's header: `<type>: <message>`, marked `Caused by:` below the outermost level. */
const headerOf = (level: ResultDef.Level, index: number): string => {
  const text = level.message ? `${level.type}: ${level.message}` : level.type

  return index === 0 ? text : `Caused by: ${text}`
}

/** A level laid out: its header (type and message cut to `headerBytes`) and its `at` lines. */
const blockOf = (full: ResultDef.Level, index: number, headerBytes: number): ResultDef.Block => {
  const level = {
    ...full,
    type: cutBytes(full.type, headerBytes),
    message: cutBytes(full.message, headerBytes),
  }

  return {
    header: headerOf(level, index),
    lines: level.causes.map(cause => `${INDENT}at ${cause}`),
  }
}

/**
 * Keep every header the budget allows: drop middle levels (outer ones first — the innermost is the
 * root cause), then the outermost, then cut the innermost header itself.
 * Dropped levels are counted by one `... N more levels` line while it fits.
 */
const fitHeaders = (blocks: ResultDef.Block[], maxBytes: number) => {
  const kept = [...blocks]
  let omitted = 0
  let marked = true

  const headersCost = () =>
    kept.reduce((total, block) => total + cost(block.header), -1) +
    (marked && omitted > 0 ? cost(omission(omitted)) : 0)

  while (kept.length > 2 && headersCost() > maxBytes) {
    kept.splice(1, 1)
    omitted += 1
  }

  if (kept.length === 2 && headersCost() > maxBytes) {
    kept.splice(0, 1)
    omitted += 1
  }

  if (headersCost() > maxBytes) {
    marked = false
  }

  const innermost = kept.at(-1)
  if (innermost && headersCost() > maxBytes) {
    innermost.header = cutBytes(innermost.header, maxBytes)
    innermost.lines = []
  }

  return { kept, omitted: marked ? omitted : 0, used: Math.max(0, headersCost()) }
}

/**
 * The Java-style rendering of a failure's chain within a UTF-8 byte budget — one level per failure,
 * depth first (a failure and its string causes, then each failure it wraps as a `Caused by:`
 * level): every level's header is reserved first (the innermost one is never dropped), then the
 * `at` lines fill what is left innermost level first, each level eliding its remainder with
 * `    ... N more`.
 */
export const renderChain = (
  failure: Result.Failure<unknown>,
  options: ResultDef.FormatOptions,
): string => {
  // a missing or non-finite budget is the default cap, full-length messages included
  const budgeted = options.maxBytes !== undefined && Number.isFinite(options.maxBytes)
  const maxBytes = budgeted ? Math.max(0, Math.floor(options.maxBytes as number)) : CHAIN_MAX_BYTES
  const headerBytes = budgeted ? HEADER_BUDGET_BYTES : HEADER_MAX_BYTES

  const blocks = walk(failure, CHAIN_DEPTH, CHAIN_LEVELS).map((level, index) =>
    blockOf(levelOf(level), index, headerBytes),
  )

  const { kept, omitted, used } = fitHeaders(blocks, maxBytes)
  let remaining = maxBytes - used

  // reserve every level's `... N more` up front, so an outer level is never elided silently
  const reserves = kept.map(block =>
    block.lines.length > 0 ? cost(elision(block.lines.length)) : 0,
  )
  let pending = reserves.reduce((total, reserve) => total + reserve, 0)
  if (pending > remaining) {
    reserves.fill(0)
    pending = 0
  }

  const bodies = kept.map((): string[] => [])

  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const block = kept[index] as ResultDef.Block
    const body = bodies[index] as string[]
    pending -= reserves[index] ?? 0
    const available = remaining - pending
    let spent = 0

    for (const line of block.lines) {
      const after = block.lines.length - (body.length + 1)
      const tail = after > 0 ? cost(elision(after)) : 0
      if (spent + cost(line) + tail > available) {
        break
      }
      body.push(line)
      spent += cost(line)
    }

    const elided = block.lines.length - body.length
    if (elided > 0 && spent + cost(elision(elided)) <= available) {
      body.push(elision(elided))
      spent += cost(elision(elided))
    }

    remaining -= spent
  }

  const out: string[] = []
  for (const [index, block] of kept.entries()) {
    if (index === 0 && omitted > 0 && kept.length === 1) {
      out.push(omission(omitted))
    }
    out.push(block.header, ...(bodies[index] ?? []))
    if (index === 0 && omitted > 0 && kept.length > 1) {
      out.push(omission(omitted))
    }
  }

  return out.join('\n')
}
