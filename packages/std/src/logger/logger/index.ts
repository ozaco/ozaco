import { loggerPluginBase } from './base'

import { apiAction } from './actions/api'
import { contextAction } from './actions/context'

export const createLogger = loggerPluginBase.register(contextAction).register(apiAction)
