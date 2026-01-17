import { createDefinition } from 'std:plugin'
import { guard } from 'std:result'

import { IOErrors } from '../../const'
import type { Impl } from '../../type'

import { path as pathDefinition } from './path'

export const handle = createDefinition(({ use }): Impl.Handle => {
  const path = use(pathDefinition)

  return guard((str, options = {}) => {
    const target = path.basename(str)
    const extname = path.extname(str)?.slice(1) ?? null
    const fullDirname = path.dirname(str)
    const type = path.type(str)

    const dirname = options.root ? path.relative(options.root, fullDirname) : fullDirname

    return {
      target,
      extname,
      dirname,
      root: options.root ?? null,

      type,
      data: options.data ?? null,
    }
  }, IOErrors.handle)
}).key('handle')
