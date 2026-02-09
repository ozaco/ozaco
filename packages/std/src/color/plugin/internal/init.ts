import { createDefinition } from 'std:plugin'

import type { Options } from '../../type'

import { context } from '../base'

export const initImplementation = createDefinition(({ use }) => {
  const ctx = use(context)

  return (options?: Options) => {
    ctx.enabled = options?.enabled ?? ctx.enabled
  }
})

export const getOptions = createDefinition(({ use }) => {
  const ctx = use(context)

  return () => ctx
}).key('getOptions')
