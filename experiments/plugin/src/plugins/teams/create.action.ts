import { logger } from '../../consts'

import { teamsPluginBase } from './base'

export const createAction = teamsPluginBase.action('create', rawCtx => {
  const ctx = rawCtx

  // biome-ignore lint/suspicious/useAwait: Redundant
  const one = ctx.$safe('one', async function* (name: string) {
    const users = yield* ctx.$get('users')
    const targetUser = yield* users.data.getOne(name)

    logger.log('created team', targetUser)

    return {
      name,
    }
  })

  return ctx.apply({ one })
})
