import { $fn, err } from '@ozaco/std/results'

import { exampleTags } from '../tag'
import { users } from './data'
import { logger } from '../consts'

export const $getUser = $fn((name: string) => {
  const found = users.find(user => user.name === name)

  if (!found) {
    return err(exampleTags.get('not-found'), 'user not found')
  }

  logger.log('found user', found)

  return found
}, exampleTags.get('get-user'))
