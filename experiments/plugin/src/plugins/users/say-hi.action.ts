import { usersPluginBase } from './base'

import { dataAction } from './data.action'

export const sayHiAction = usersPluginBase.action('sayHi', rawCtx => {
  const ctx = rawCtx

  const to = ctx.$safe('to', function* (name: string) {
    const data = ctx.$peek(dataAction)

    const targetUser = yield* data.getOne(name)

    return `hi ${targetUser.name} ${targetUser.surname}`
  })

  return ctx.apply({ to })
})
