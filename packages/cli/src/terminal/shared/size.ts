import type { Size } from 'cli:core'
import { DEFAULT_COLUMNS, DEFAULT_ROWS, Terminal } from 'cli:core'
import { attempt, call, operation, useContext } from 'std:effect'
import { IO } from 'std:io'
import { isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { execFileSync } from 'node:child_process'
import { constants, openSync } from 'node:fs'
import { WriteStream } from 'node:tty'

const create = operation(function* (columns?: string | number, rows?: string | number) {
  return {
    columns: Math.trunc(Number(`${columns}`)),
    rows: Math.trunc(Number(`${rows}`)),
  } as Size
})

const createIfNotDefault = operation(function* (maybeColumns?: string, maybeRows?: string) {
  const size = yield* create(maybeColumns, maybeRows)

  if (Number.isNaN(size.columns) || Number.isNaN(size.rows)) {
    return undefined
  }

  if (size.columns === DEFAULT_COLUMNS && size.rows === DEFAULT_ROWS) {
    return undefined
  }

  return size
})

const exec = (
  command: string,
  args: readonly string[],
  options: { shell?: boolean | string; env?: AnyType } = {},
): string =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 500,
    shell: options.shell,
    env: options.env,
  }).trim()

// Live host-stream dimensions. std:io has no stdout/stderr surface, so the raw `process`
// reads are lifted through call() to stay effect-tracked and lazy.
const fromStreams = operation(function* () {
  const ctx = yield* useContext(Terminal)

  if (ctx.output?.columns && ctx.output?.rows) {
    return yield* create(ctx.output.columns, ctx.output.rows)
  }

  if (ctx.error?.columns && ctx.error?.rows) {
    return yield* create(ctx.error.columns, ctx.error.rows)
  }

  return undefined
})

// COLUMNS/LINES are static, so not the first choice. This is the one probe std:io owns.
const fromEnv = operation(function* () {
  const { columns, rows } = yield* IO.actions.env(data => ({
    columns: data.COLUMNS ?? null,
    rows: data.LINES ?? null,
  }))

  return columns && rows ? yield* create(columns, rows) : undefined
})

const devTty = operation(function* () {
  const result = yield* attempt(
    call((): Size => {
      const flags =
        process.platform === 'darwin'
          ? (constants as AnyType).O_EVTONLY | constants.O_NONBLOCK
          : constants.O_NONBLOCK
      const { columns, rows } = new WriteStream(openSync('/dev/tty', flags))
      return { columns, rows }
    }),
  )

  return isSuccess(result) ? result.value : undefined
})

// On macOS, this only returns correct values when stdout is not redirected.
const tput = operation(function* () {
  const result = yield* attempt(
    call(() => {
      // `tput` requires the `TERM` environment variable to be set.
      const columns = exec('tput', ['cols'], { env: { TERM: 'dumb', ...process.env } })
      const rows = exec('tput', ['lines'], { env: { TERM: 'dumb', ...process.env } })

      return columns && rows ? { columns, rows } : undefined
    }),
  )

  return isSuccess(result)
    ? yield* createIfNotDefault(result.value?.columns, result.value?.rows)
    : undefined
})

// Confirms we own the controlling terminal — reads /proc/self/stat through std:io.
const isForegroundProcess = operation(function* () {
  if (process.platform !== 'linux') {
    return true
  }

  const result = yield* attempt(IO.actions.readText('/proc/self/stat'))
  if (!isSuccess(result)) {
    return false
  }

  const closingParenthesisIndex = result.value.lastIndexOf(') ')
  if (closingParenthesisIndex === -1) {
    return false
  }

  const statFields = result.value
    .slice(closingParenthesisIndex + 2)
    .trim()
    .split(/\s+/u)

  const processGroupId = Math.trunc(Number(statFields[2]!))
  const foregroundProcessGroupId = Math.trunc(Number(statFields[5]!))

  if (Number.isNaN(processGroupId) || Number.isNaN(foregroundProcessGroupId)) {
    return false
  }

  if (foregroundProcessGroupId <= 0) {
    return false
  }

  return processGroupId === foregroundProcessGroupId
})

// `resize` works even when all file descriptors are redirected — https://linux.die.net/man/1/resize
const resize = operation(function* () {
  if (!(yield* isForegroundProcess())) {
    return undefined
  }

  const result = yield* attempt(
    call(() => {
      const size = exec('resize', ['-u']).match(/\d+/gu)
      return size && size.length === 2 ? { columns: size[0]!, rows: size[1]! } : undefined
    }),
  )

  return isSuccess(result)
    ? yield* createIfNotDefault(result.value?.columns, result.value?.rows)
    : undefined
})

export const terminalSize = operation(function* () {
  const fallback: Size = { columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS }

  const streams = yield* fromStreams()
  if (streams) {
    return streams
  }

  const environment = yield* fromEnv()
  if (environment) {
    return environment
  }

  // We include `tput` for Windows users using Git Bash.
  if (process.platform === 'win32') {
    return (yield* tput()) ?? fallback
  }

  if (process.platform === 'darwin') {
    return (yield* devTty()) ?? (yield* tput()) ?? fallback
  }

  return (yield* devTty()) ?? (yield* tput()) ?? (yield* resize()) ?? fallback
})
