import { exampleCore } from '../core'

export const otherAction = exampleCore.action('other', ctx => {
  const other = ctx.$fn('other', <T extends string>(name: T) => `other ${name}` as const)

  return ctx.apply({ other })
})
