import type { Writable } from 'node:stream'

import type { LEVEL, TransportOptions } from 'std:logger'

import type { Expand } from 'std:shared'

export type FileTransportOptions = Expand<
  TransportOptions & {
    path?: string | undefined
    limit?: number | undefined
    platform?: boolean | undefined
    highWaterMark?: number | undefined

    stream?: Writable
  }
>

export type FileTransportContext = Expand<
  Required<Omit<FileTransportOptions, 'level'>> & {
    level?: LEVEL | undefined
    queue: string[]
    draining: boolean
    platformInfo: string
  }
>
