import { fileURLToPath } from 'node:url'
import { createDefinition } from 'std:plugin'

import { HANDLE } from '../../const'
import type { Impl } from '../../types'
import { isHandle } from '../../utils'
import { path as pathDefinition } from './path'

export const handle = createDefinition(({ use }): Impl.Handle => {
  const path = use(pathDefinition)

  return (str, root) => {
    if (isHandle(str)) {
      return str
    }

    let isURL = false

    if (str instanceof URL) {
      str = fileURLToPath(str)
      isURL = true
    }

    const target = path.basename(str)
    const extname = path.extname(str)?.slice(1) ?? null
    const dirname = path.dirname(str)
    const type = path.type(str)

    return {
      _t: HANDLE,

      target,
      extname,
      dirname,
      root: root ?? null,

      type,

      get assembled() {
        const result = path.join(root ?? '', dirname, target)

        if (isURL) {
          return new URL(result)
        }

        return result
      },
    }
  }
}).key('handle')
