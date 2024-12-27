/// <reference path="../shared/index.ts" />
/// <reference path="../results/index.ts" />
/// <reference path="../io/index.ts" />

import type { BlobType } from '../shared'
import type { LOGGER_LEVELS } from './consts'

import type { loggerTags } from './tag'

declare global {
  namespace Std {
    // ------------ Errors ------------
    interface Error {
      'std/logger': typeof loggerTags
    }

    namespace Logger {
      interface Message {
        level: 'err' | 'warn' | 'log'
        messages: string[]
        date: Date
        noConsole: boolean
      }

      type Transport = (message: Message) => void

      interface Options {
        name: string
        level?: (typeof LOGGER_LEVELS)[number]

        transports?: Transport[]
      }

      interface Api {
        name: string

        options: Required<Std.Logger.Options> & {
          levelIndex: number
        }

        get date(): [string, Date]

        callTransports: (message: Message) => void

        log: (...args: BlobType[]) => void
        err: (...args: BlobType[]) => void
        warn: (...args: BlobType[]) => void
      }

      // ------------ Transports ------------
      interface FileTransportOptions {
        dir?: string
      }
    }
  }
}
