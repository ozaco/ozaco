import type { Writable } from 'node:stream'

import type { TransportOptions } from 'std:logger'

import type { Expand } from 'std:shared'

export type FileTransportOptions = Expand<
  TransportOptions & {
    path?: string

    stream?: Writable
  }
>

export type FileTransportContext = Expand<Required<FileTransportOptions>>
