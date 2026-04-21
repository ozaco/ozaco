import type { AnyType } from 'std:shared'

export type PathLike = string | URL

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
