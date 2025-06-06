/// <reference types="@ozaco/std/shared" />
/// <reference types="@ozaco/std/results" />
/// <reference types="@ozaco/std/plugin" />

import type { pluginTags } from './tag'

declare global {
  namespace Std {
    // ------------ Std - results ------------

    interface Error {
      plugin: typeof pluginTags
    }
  }
}
