/// <reference types="@ozaco/std/shared" />
/// <reference types="@ozaco/std/results" />
/// <reference types="@ozaco/std/plugin" />

import type { exampleTags } from './tag'

declare global {
  namespace Std {
    // ------------ Std - results ------------

    interface Error {
      examples: typeof exampleTags
    }
  }
}
