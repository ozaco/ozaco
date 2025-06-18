import { loggerPluginBase } from './base'

import { contextAction } from './actions/context'
import { apiAction } from './actions/api'

export const createLogger = loggerPluginBase.register(contextAction).register(apiAction)
