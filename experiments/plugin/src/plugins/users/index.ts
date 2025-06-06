import { usersPluginBase } from './base'

import { dataAction } from './data.action'
import { sayHiAction } from './say-hi.action'

export const usersPlugin = usersPluginBase.register(dataAction).register(sayHiAction)
