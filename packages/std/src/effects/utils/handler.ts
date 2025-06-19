import process from 'node:process'
import { Err } from '../../results'
import { ENV, logger } from '../consts'

if (ENV.handler) {
  process
    .on('unhandledRejection', (_reason, p) => {
      if (p instanceof Err) {
        logger.err({ ...p })
      } else {
        logger.err(p)
      }
    })
    .on('uncaughtException', err => {
      if (err instanceof Err) {
        logger.err({ ...err })
      } else {
        logger.err(err)
      }

      process.exit(1)
    })
}
