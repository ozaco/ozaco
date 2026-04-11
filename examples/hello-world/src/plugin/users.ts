import { operation, useContext } from 'std:effect'
import { definePlugin } from 'std:plugin'

const UserDefinition = definePlugin({
  name: 'users',
  version: '0.0.0',
  // oxlint-disable-next-line require-yield
  *setup(use, greetingMessage: string) {
    return greetingMessage
  },
})

const GreetAction = operation(function* <T extends string>(name: T) {
  const userCtx = yield* useContext(UserDefinition.context)

  return `${userCtx} ${name}` as const
}, 'greet')

export const UserPlugin = UserDefinition.build({
  greet: GreetAction,
})
