import type { ExecOptions, ProcessStatus } from '../types/common'
import { toPath } from '../utils/to-path'

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

/** Derive a {@link ProcessStatus} from a raw exit code and terminating signal. */
export const makeStatus = (code: number | null, signal: string | null): ProcessStatus => ({
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

export interface SpawnConfig {
  cwd?: string
  env?: Record<string, string>
  timeout?: number
}

/** Reduce the public process options into a platform-agnostic, defined-keys-only config. */
export const normalizeSpawn = (options?: ExecOptions): SpawnConfig => {
  const config: SpawnConfig = {}
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
