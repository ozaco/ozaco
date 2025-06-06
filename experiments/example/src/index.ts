import './definition'
import '@ozaco/std/effects'

import { logger } from './consts'
import { $sayHi } from './users/say-hi'

$sayHi('alice').unwrap()

logger.info('example info log')
logger.success('example success log')
logger.trace('example trace log')
logger.debug('example debug log')

export * from './consts'
export * from './tag'
