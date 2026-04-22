import { RestTransformer } from 'server:core'
import { defineAction } from 'server:service'

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
