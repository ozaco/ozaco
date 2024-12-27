/// <reference path="../shared/index.ts" />
/// <reference path="../results/index.ts" />

import type { ioTags } from './tag'

declare global {
  namespace Std {
    // ------------ Errors ------------
    interface Error {
      'std/io': typeof ioTags
    }
  }
}
