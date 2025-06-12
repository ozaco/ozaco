import { err } from '@ozaco/std/results'

import { usersPluginBase } from './base'

const users = [
  {
    name: 'alice',
    surname: 'zuberg',
    age: 19,
  },
]

export const dataAction = usersPluginBase.action('data', async rawCtx => {
  const ctx = rawCtx.$tag('not-found')

  const getOne = ctx.$fn('getOne', (name: string) => {
    const found = users.find(user => user.name === name)

    if (!found) {
      return err(ctx.tags.get('data/not-found'), 'user not found')
    }

    return found
  })

  const getMany = ctx.$fn('getMany', (names: string[]) => {
    const found = users.filter(user => names.includes(user.name))

    if (found.length === 0) {
      return err(ctx.tags.get('data/not-found'), 'user not found')
    }

    return found
  })

  return ctx.apply({ getOne, getMany })
})
