import { defineAction, Rest } from 'server:core'

export const preflightAction = defineAction(
  {
    title: 'cors-preflight',
    settings: [Rest.actions.settings({ method: 'OPTIONS', path: '/**' })],
  },

  function* () {
    return undefined
  },
)
