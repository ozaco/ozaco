import { logger } from '../../consts'

import { teamsPluginBase } from './base'

export const createAction = teamsPluginBase.action('create', rawCtx => {
  const ctx = rawCtx

  const one = ctx.$safe('one', function* (name: string) {
    const users = yield* ctx.$get('users')
    const targetUser = yield* users.data.getOne(name)

    logger.log('created team', targetUser)

    return {
      name,
    }
  })

  return ctx.apply({ one })
})
