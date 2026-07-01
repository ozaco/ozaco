import type { Future, Stream } from 'std:effect'
import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

export type PathLike = string | URL

/** The close value an IO byte stream settles with: `true` on a clean end, or the failure that interrupted it. */
export type StreamClose = true | Result.Failure<unknown>

export type HashAlgorithm = 'SHA-256' | 'SHA-384' | 'SHA-512'

export interface IOStat {
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
  size: number
  mtime: Date | null
  atime: Date | null
  birthtime: Date | null
}

export interface WalkEntry {
  path: string
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
}

export interface NodeReadableLike {
  on(event: string, listener: (...args: AnyType[]) => void): this
  off(event: string, listener: (...args: AnyType[]) => void): this
  destroy?(error?: Error): this
}

export interface WebReadableLike {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>
  cancel(reason?: AnyType): Promise<void>
  releaseLock(): void
}

export type ReadableLike = NodeReadableLike | WebReadableLike

export interface WritableLike {
  write(chunk: Uint8Array): boolean
  end(): this
  destroy?(error?: Error): this
  on(event: string, listener: (...args: AnyType[]) => void): this
  once(event: string, listener: (...args: AnyType[]) => void): this
  off(event: string, listener: (...args: AnyType[]) => void): this
}

export interface WalkOptions {
  flags?: number | undefined
  maxDepth?: number | undefined
  match?: RegExp[] | undefined
  skip?: RegExp[] | undefined
}

/** Options shared by {@link IOActions.exec} and {@link IOActions.spawn}. */
export interface ProcessOptions {
  /** Working directory for the child. Defaults to the parent's cwd. */
  cwd?: PathLike
  /** Environment overrides, layered over the parent's `process.env` (set a key to `undefined` to drop it). */
  env?: Record<string, string | undefined>
}

/** Options for {@link IOActions.exec}. */
export interface ExecOptions extends ProcessOptions {
  /** Bytes (or text) written to the child's stdin, which is then closed. */
  stdin?: Uint8Array | string
  /** Kill the child after this many milliseconds. */
  timeout?: number
}

/** Options for {@link IOActions.spawn}. */
export type SpawnOptions = ProcessOptions

/** The exit status of a child process. */
export interface ProcessStatus {
  /** Exit code, or `null` when the process was terminated by a signal. */
  code: number | null
  /** Terminating signal name (e.g. `'SIGTERM'`), or `null` when it exited on its own. */
  signal: string | null
  /** `true` when the process exited cleanly (`code === 0` and no signal). */
  success: boolean
}

/** The buffered result of running a command to completion via {@link IOActions.exec}. */
export interface ExecResult extends ProcessStatus {
  stdout: Uint8Array
  stderr: Uint8Array
}

/** A handle to a child process spawned via {@link IOActions.spawn}. */
export interface ProcessHandle {
  /** OS process id (`-1` if the process never started). */
  readonly pid: number
  /** The child's stdout as a byte stream. */
  readonly stdout: Stream<Uint8Array, StreamClose>
  /** The child's stderr as a byte stream. */
  readonly stderr: Stream<Uint8Array, StreamClose>
  /** Resolve with the exit status once the process ends. */
  exited: () => Future<ProcessStatus, unknown>
  /** Write a chunk to the child's stdin. */
  write: (chunk: Uint8Array | string) => Future<void, unknown>
  /** Close the child's stdin. */
  closeStdin: () => Future<void, unknown>
  /** Send a termination signal (default `SIGTERM`). */
  kill: (signal?: number | string) => Future<void, unknown>
}
