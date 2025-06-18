import './definition'
import { createLogger } from './logger'

export * from './consts'
export * from './logger'

const logger = createLogger('test', 'trace')

logger.trace('trace')
logger.debug('debug')
logger.log('log')
logger.info('info')
logger.success('success')
logger.warn('warn')
logger.err('err')
