import { createDefinition } from 'std:plugin'
import { guard } from 'std:result'

import { IOErrors } from '../../const'
import type { Impl } from '../../type'

export const handle = createDefinition((): Impl.Handle => {
  return guard((path, options = {}) => {
    const splitted = path.split('/').filter(x => x.trim().length > 0)

    const fullTarget = splitted.pop() ?? '/'
    const [target, ...extensions] = fullTarget.split('.')

    let dirPaths: string[] = splitted

    const splittedRoot = options.root?.split('/').filter(x => x.trim().length > 0) ?? []

    if (splittedRoot.length > 0) {
      dirPaths = splitted.slice(splittedRoot.length)
    }

    return {
      // biome-ignore lint/style/noNonNullAssertion: Redundant
      target: target!,
      extension: extensions.length > 0 ? extensions.join('.') : null,

      dir: dirPaths.join('/'),

      root: options.root ?? null,
      data: options.data ?? null,
    }
  }, IOErrors.handle)
}).key('handle')
