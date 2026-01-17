import type { BlobType } from 'std:shared'

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
    extension: string | null

    dir: string
    root: string | null

    data: BlobType
  }
}
