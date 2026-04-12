export type PathLike = string | URL

export type IOErrorTag =
  | 'io:read'
  | 'io:write'
  | 'io:stat'
  | 'io:rm'
  | 'io:dir'
  | 'io:copy'
  | 'io:rename'
  | 'io:exists'
  | 'io:walk'

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

export interface WalkOptions {
  maxDepth?: number | undefined
  includeFiles?: boolean | undefined
  includeDirs?: boolean | undefined
  followSymlinks?: boolean | undefined
  match?: RegExp[] | undefined
  skip?: RegExp[] | undefined
}
