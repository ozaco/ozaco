import { apiAction } from './actions/api'
import { contextAction } from './actions/context'
import { loggerPluginBase } from './base'

export const createLogger = loggerPluginBase.register(contextAction).register(apiAction)
