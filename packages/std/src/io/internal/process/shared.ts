import type { Flow, Operation } from 'std:effect'
import { flowOf } from 'std:effect'
import { fail } from 'std:result'

import { IOErrors } from '../../errors'
import type { Helpers } from '../../types/helpers'
import type { IODef } from '../../types/io'
import { toPath } from '../../utils/to-path'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Normalize text-or-bytes stdin input into bytes for a child process. */
export const toBytes = (input: Uint8Array | string): Uint8Array =>
  typeof input === 'string' ? encoder.encode(input) : input

/**
 * Build the child environment by layering the caller's overrides over the parent's `process.env`,
 * dropping any `undefined` entries (the platform spawn APIs reject them). Returns `undefined` when
 * no overrides are given, so the child inherits the parent environment as-is.
 */
export const mergeEnv = (
  overrides?: Record<string, string | undefined>,
): Record<string, string> | undefined => {
  if (!overrides) {
    return undefined
  }

  const base =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  const merged: Record<string, string> = {}

  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value !== undefined) {
      merged[key] = value
    }
  }

  return merged
}

/** Derive a {@link IODef.ProcessStatus} from a raw exit code and terminating signal. */
export const makeStatus = (code: number | null, signal: string | null): IODef.ProcessStatus => ({
  code,
  signal,
  success: code === 0 && signal === null,
})

/** The {@link IODef.ExecResult} of a finished command: the status and the buffered streams plus
 * the readers over them — `text()` (stderr, then stdout), `said()` (that trimmed, else the
 * signal / `exit code <n>`) and `must(tag)` (`text()`, or the failure `<cmd> <args>\n<said()>`).
 * `line` is the command and its arguments. */
export const makeExecResult = (
  line: readonly string[],
  status: IODef.ProcessStatus,
  streams: { stdout: Uint8Array; stderr: Uint8Array },
): IODef.ExecResult => {
  const text = () => `${decoder.decode(streams.stderr)}${decoder.decode(streams.stdout)}`
  const said = () => {
    const printed = text().trim()

    return printed === '' ? (status.signal ?? `exit code ${status.code}`) : printed
  }

  return {
    ...status,
    ...streams,
    text,
    said,
    *must(tag) {
      if (!status.success) {
        return yield* fail(tag, `${line.join(' ')}\n${said()}`)
      }

      return text()
    },
  }
}

/** Concatenate a list of byte chunks into one contiguous buffer. */
export const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array => {
  let total = 0

  for (const chunk of chunks) {
    total += chunk.length
  }

  const out = new Uint8Array(total)
  let offset = 0

  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }

  return out
}

/** Reduce the public process options into a platform-agnostic, defined-keys-only config. */
export const normalizeSpawn = (options?: IODef.ExecOptions): Helpers.SpawnConfig => {
  const config: Helpers.SpawnConfig = {}

  if (options?.cwd !== undefined) {
    config.cwd = toPath(options.cwd)
  }

  const env = mergeEnv(options?.env)

  if (env !== undefined) {
    config.env = env
  }

  if (options?.timeout !== undefined) {
    config.timeout = options.timeout
  }

  return config
}

/** Resolve `SpawnOptions.stdio` per stream — an omitted stream stays `'pipe'`. */
export const resolveStdio = (stdio: IODef.SpawnOptions['stdio']): Helpers.StdioConfig => {
  if (stdio === undefined || typeof stdio === 'string') {
    const mode = stdio ?? 'pipe'

    return { stdin: mode, stdout: mode, stderr: mode }
  }

  return {
    stdin: stdio.stdin ?? 'pipe',
    stdout: stdio.stdout ?? 'pipe',
    stderr: stdio.stderr ?? 'pipe',
  }
}

/** The platform-level spawn options `detached` / `windowsHide` ask for, only when set (an
 * explicit `undefined` is not the same as an absent key to every spawn). */
export const detachFlags = (
  options?: IODef.SpawnOptions,
): { detached?: boolean; windowsHide?: boolean } => ({
  ...(options?.detached ? { detached: true } : {}),
  ...(options?.windowsHide ? { windowsHide: true } : {}),
})

/** The flow a stdout/stderr that is NOT piped exposes on the handle: nothing, closed clean at once. */
export const emptyByteFlow = (): Flow<Uint8Array, IODef.FlowClose> =>
  flowOf<Uint8Array, IODef.FlowClose>(function* () {
    return true
  })

/** A handle's stdout/stderr flow around the platform stream: subscribed after `detach()` it ends
 * `true` at once (the parent's end is gone — a Node stream destroyed before anyone listened would
 * never emit `close`); before, the source's own chunks and close value. */
export const unlessDetached = (
  source: Flow<Uint8Array, IODef.FlowClose>,
  detached: () => boolean,
): Flow<Uint8Array, IODef.FlowClose> =>
  flowOf<Uint8Array, IODef.FlowClose>(function* (emit) {
    if (detached()) {
      return true
    }

    const subscription = yield* source

    while (true) {
      const item = yield* subscription.next()

      if (item.done) {
        return item.value
      }

      yield* emit(item.value)
    }
  })

/** What `write` answers when stdin is not piped: the child reads the terminal, nothing or a file,
 * not the parent — and, after `detach()`, nothing at all. */
export function* inheritedStdinWrite(): Operation<void> {
  return yield* fail(IOErrors.StdinWriteFailed, 'stdin is not piped: nothing to write to')
}

/** `IO.actions.run` over an impl's `spawn`: the child on the parent's terminal (`stdio` defaults
 * to `'inherit'`), answered by its exit status. */
export const createRun = (spawnProcess: IODef.Actions['spawn']): IODef.Actions['run'] =>
  function* run(cmd, args, options) {
    const handle = yield* spawnProcess(cmd, args, {
      ...options,
      stdio: options?.stdio ?? 'inherit',
    })

    return yield* handle.exited()
  }
