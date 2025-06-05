/// <reference types="@ozaco/std/shared" />
/// <reference types="@ozaco/std/results" />
/// <reference types="@ozaco/std/plugin" />

import type { filesTags } from './tag'

declare global {
  namespace Std {
    // ------------ Std - results ------------

    interface Error {
      filess: typeof filesTags
    }
  }
}
