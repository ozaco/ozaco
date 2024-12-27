/// <reference types="@ozaco/std/shared" />
/// <reference types="@ozaco/std/results" />

import type { exampleTags } from './tag'

declare global {
  namespace Std {
    // ------------ Std - results ------------

    interface Error {
      examples: typeof exampleTags
    }
  }
}
