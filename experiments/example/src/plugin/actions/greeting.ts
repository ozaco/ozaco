import { exampleCore } from '../core'

export const greetingAction = exampleCore.action('greeting', ctx => {
  const hello = ctx.$fn('hello', <T extends string>(name: T) => `hello ${name}` as const)

  return ctx.apply({ hello })
})
