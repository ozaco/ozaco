import { usersPluginBase } from './base'

import { dataAction } from './data.action'

export const sayHiAction = usersPluginBase.action('sayHi', rawCtx => {
  const ctx = rawCtx

  // biome-ignore lint/suspicious/useAwait: <explanation>
  const to = ctx.$safe('to', async function* (name: string) {
    const data = yield* ctx.$peek(dataAction)

    const targetUser = yield* data.getOne(name)

    return `hi ${targetUser.name} ${targetUser.surname}`
  })

  return ctx.apply({ to })
})
