import { createTags } from 'std:shared'

/** The failure tags HotReload raises besides the server's own. */
export const HotReloadErrors = createTags(
  'server:hot-reload',

  /** the entry module could not be evaluated (a syntax error, a failing import). */
  'load',
)
