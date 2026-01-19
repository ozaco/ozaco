import { createDefinition } from 'std:plugin'

import type { Impl } from '../../type'

import { path as pathDefinition } from './path'

export const handle = createDefinition(({ use }): Impl.Handle => {
  const path = use(pathDefinition)

  return (str, root) => {
    const target = path.basename(str)
    const extname = path.extname(str)?.slice(1) ?? null
    const dirname = path.dirname(str)
    const type = path.type(str)

    return {
      target,
      extname,
      dirname,
      root: root ?? null,

      type,

      get assembled() {
        return path.join(root ?? '', dirname, target)
      },
    }
  }
}).key('handle')
