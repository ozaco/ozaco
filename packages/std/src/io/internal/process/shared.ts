import type { Flow, Operation } from 'std:effect'
import { flowOf } from 'std:effect'
import { fail } from 'std:result'

import { IOErrors } from '../../errors'
import type { Helpers } from '../../types/helpers'
import type { IODef } from '../../types/io'
import { toPath } from '../../utils/to-path'

const encoder = new TextEncoder()

/** Normalize text-or-bytes stdin input into bytes for a child process. */
export const toBytes = (input: Uint8Array | string): Uint8Array =>
  typeof input === 'string' ? encoder.encode(input) : input

/** Pull a human-readable message out of an unknown thrown/rejected value. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

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

/** The flow an INHERITED stdout/stderr exposes on the handle: nothing, closed clean at once. */
export const emptyByteFlow = (): Flow<Uint8Array, IODef.FlowClose> =>
  flowOf<Uint8Array, IODef.FlowClose>(function* () {
    return true
  })

/** What `write` answers when stdin is inherited: the child reads the terminal, not the parent. */
export function* inheritedStdinWrite(): Operation<void> {
  return yield* fail(IOErrors.StdinWriteFailed, 'stdin is inherited: nothing to write to')
}
