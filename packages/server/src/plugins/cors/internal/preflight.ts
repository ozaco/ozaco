import { RestTransformer } from 'server:core'
import type { ActionContext } from 'server:service'
import { defineAction } from 'server:service'

export const preflightAction = defineAction(
  {
    title: 'cors-preflight',
    settings: [RestTransformer.actions.settings({ method: 'OPTIONS', path: '/**' })],
  },
  // oxlint-disable-next-line require-yield
  function* (ctx: ActionContext<unknown>) {
    ctx.res.meta['Content-Type'] = 'text/plain'
    return ''
  },
)
