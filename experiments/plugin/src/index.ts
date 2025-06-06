import './definition'
import '@ozaco/std/effects'

import { usersPlugin } from './plugins/users'
import { logger } from './consts'

const users = await usersPlugin()

const greeting = users.sayHi.to('alice').unwrap()

logger.log(greeting)

export * from './consts'
export * from './tag'
