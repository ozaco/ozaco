import { createContext, operation, useContext } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'

const UserDefinition = definePlugin({
  name: 'users',
  version: '0.0.0',
  *setup(greetingMessage?: string) {
    const externalCtx = yield* useContext(external)

    if (greetingMessage === 'Welcome') {
      yield* fail('unexpected-greeting')
    } else if (greetingMessage) {
      externalCtx.data = greetingMessage
    }

    return externalCtx.data
  },
})

const GreetAction = operation(function* <T extends string>(name: T) {
  const userCtx = yield* useContext(UserDefinition.context)

  return `${userCtx} ${name}` as const
}, 'greet')

export const external = createContext('External', {
  data: 'Hi',
})

export const UserPlugin = UserDefinition.build({
  greet: GreetAction,
})
