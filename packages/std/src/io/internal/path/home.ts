import type { Operation } from 'std:effect'

import type { IODef } from '../../types/io'

/**
 * Build `expandHome` over an impl's own `homeDir` + `join`: only a LEADING `~` that stands alone or
 * is followed by a separator expands (`~user/…` is left alone — resolving another user's home needs
 * a passwd lookup); a path without one never asks for the home directory.
 */
export const createExpandHome = (
  homeDir: () => Operation<string>,
  join: IODef.Actions['join'],
): IODef.Actions['expandHome'] =>
  function* expandHome(path) {
    if (path !== '~' && !path.startsWith('~/') && !path.startsWith('~\\')) {
      return path
    }

    const home = yield* homeDir()
    return path === '~' ? home : yield* join(home, path.slice(2))
  }
