import { $fn, err } from '@ozaco/std/results'

import { logger } from '../consts'
import { exampleTags } from '../tag'
import { $getUser } from './get-user'

export const $sayHi = $fn((name: string) => {
  if (!name) {
    return err(exampleTags.get('invalid-arguments'), 'name should be defined')
  }

  const found = $getUser(name)

  if (found.isErr()) {
    return found
  }

  if (found.value.age < 18) {
    return err('?underage', 'under age')
  }

  logger.err(`Hi ${found.value.name}-${found.value.age}`)
}, exampleTags.get('say-hi'))
