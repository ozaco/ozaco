import { defineAction, RestTransformer } from 'server:core'

export const preflightAction = defineAction(
  {
    title: 'cors-preflight',
    settings: [RestTransformer.actions.settings({ method: 'OPTIONS', path: '/**' })],
  },
  // oxlint-disable-next-line require-yield
  function* () {
    return undefined
  },
)
