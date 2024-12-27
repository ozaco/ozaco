/// <reference path="../shared/index.ts" />
/// <reference path="../results/index.ts" />
/// <reference path="../io/index.ts" />

import type { BlobType } from '../shared'

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
        date: string
      }

      type Transport = (message: Message) => void

      interface Options {
        name: string

        disableConsole?: boolean
        transports?: Transport[]
      }

      interface Api {
        name: string
        rawName: string

        options: Required<Std.Logger.Options>

        get date(): string

        callTransports: (message: Message) => void

        log: (...args: BlobType[]) => void
        err: (...args: BlobType[]) => void
        warn: (...args: BlobType[]) => void
      }
    }
  }
}
