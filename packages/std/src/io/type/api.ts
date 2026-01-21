import type { BlobType } from 'std:shared'

import type { FILE, HANDLE, PathType, STATS } from '../const'

export namespace Api {
  export interface Stats<T extends number | bigint = bigint> {
    _t: typeof STATS

    get isFile(): boolean
    get isDirectory(): boolean
    get isSymlink(): boolean
    get isBlockDevice(): boolean | null
    get isFifo(): boolean | null
    get isSocket(): boolean | null

    size: T
    modification: Date | null
    access: Date | null
    device: T
    mode: T | null
    links: T | null
    blocks: T | null
    blockSize: T | null
  }

  export interface Handle {
    _t: typeof HANDLE

    target: string
    extname: string | null
    dirname: string
    root: string | null

    type: PathType

    get assembled(): string
  }

  export interface File {
    _t: typeof FILE

    // file handle or target runtime
    raw: BlobType
    handle: Api.Handle
    stats: Api.Stats

    [Symbol.dispose]: () => void
    [Symbol.asyncDispose]: () => Promise<void>
  }
}
