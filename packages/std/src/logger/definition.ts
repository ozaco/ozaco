import type { BlobType, Fn } from '../shared'
import type { LOGGER_LEVELS } from './consts'

declare global {
  namespace Std {
    namespace Logger {
      interface Message {
        level: 'trace' | 'debug' | 'log' | 'info' | 'success' | 'warn' | 'err'
        messages: string[]
        date: Date
        noConsole: boolean
      }

      type Options = [name: string, level?: (typeof LOGGER_LEVELS)[number]]

      type AnyTransport = Std.Plugin.Sync<
        BlobType,
        {
          write: Fn<[message: Message], void>
        },
        BlobType,
        BlobType
      >

      namespace FileTransport {
        type Options = [dir?: string]
      }
    }
  }
}
