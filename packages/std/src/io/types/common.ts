import type { AnyType } from 'std:shared'

export type PathLike = string | URL

export interface IOStat {
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
  size: number
  mtime: Date | null
  atime: Date | null
  birthtime: Date | null
}

export interface RmOptions {
  recursive?: boolean
  force?: boolean
}

export interface WalkEntry {
  path: string
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
}

export interface ReadableLike {
  on(event: string, listener: (...args: AnyType[]) => void): this
  off(event: string, listener: (...args: AnyType[]) => void): this
  destroy?(error?: Error): this
}

export interface WritableLike {
  write(chunk: Uint8Array): boolean
  end(): this
  destroy?(error?: Error): this
  on(event: string, listener: (...args: AnyType[]) => void): this
  once(event: string, listener: (...args: AnyType[]) => void): this
  off(event: string, listener: (...args: AnyType[]) => void): this
}

export interface WalkOptions {
  maxDepth?: number | undefined
  includeFiles?: boolean | undefined
  includeDirs?: boolean | undefined
  followSymlinks?: boolean | undefined
  match?: RegExp[] | undefined
  skip?: RegExp[] | undefined
}
