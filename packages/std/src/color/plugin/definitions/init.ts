import { createDefinition } from 'std:plugin'

import type { Options } from '../../type'

import { optionsContext } from '../context'

export const init = createDefinition(({ use }) => {
  const ctx = use(optionsContext)

  return (options?: Options) => {
    ctx.enabled = options?.enabled ?? ctx.enabled
  }
})

export const getOptions = createDefinition(({ use }) => {
  const ctx = use(optionsContext)

  return () => {
    return ctx
  }
}).key('getOptions')
