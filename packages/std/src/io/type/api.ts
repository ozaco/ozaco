import type { BlobType } from 'std:shared'

import type { PathType } from '../const'

export namespace Api {
  export interface Stats<T extends number | bigint = bigint> {
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
    target: string
    extname: string | null
    dirname: string
    root: string | null

    type: PathType

    get assembled(): string
  }

  export interface File {
    // file handle or target runtime
    raw: BlobType
    handle: Api.Handle
    stats: Api.Stats

    [Symbol.dispose]: () => void
    [Symbol.asyncDispose]: () => Promise<void>
  }
}
