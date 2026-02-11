import { createDefinition } from 'std:plugin'

import { Runtime } from '../../const'
import type { Impl } from '../../types'
import { detectRuntime } from '../../utils'
import { ioContext } from '../base'

export const initDefinition = createDefinition(({ use }): Impl.Init => {
  const context = use(ioContext)

  return (options = {}) => {
    if (!options.runtime || options.runtime === Runtime.unknown) {
      context.runtime = detectRuntime()
    } else {
      context.runtime = options.runtime
    }
  }
}).key('setOptions')
