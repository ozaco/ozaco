import { deepMerge } from 'std:shared'

import type { ConfigDef } from '../types'

/** A source's effective data: its `extends` (lower) merged under its own data (higher). */
const resolve = (source: ConfigDef.Source): ConfigDef.Object =>
  deepMerge(...source.extends.map(resolve), source.data)

/**
 * Merge the discovered chain into a single object. The chain is stored innermost → outermost (index
 * 0 wins), so it is folded in reverse (outermost = lowest precedence first); the `env` overlay is
 * applied last as the highest-precedence source.
 */
export const mergeChain = (chain: ConfigDef.Source[], env: ConfigDef.Object): ConfigDef.Object =>
  deepMerge(...[...chain].toReversed().map(resolve), env)
