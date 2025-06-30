import type { ioTags } from './tag'

declare global {
  namespace Std {
    // ------------ Errors ------------
    interface Error {
      'std/io': typeof ioTags
    }

    namespace Io {
      interface WriteJsonOptions {
        create?: boolean
        ignore?: boolean
      }
    }
  }
}
