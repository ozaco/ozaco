import './definition'
import '@ozaco/std/effects'

import { logger } from './consts'
import { usersPlugin } from './plugins/users'

const users = await usersPlugin()

const greeting = users.sayHi.to('alice').unwrap()

logger.log(greeting)

export * from './consts'
export * from './tag'
