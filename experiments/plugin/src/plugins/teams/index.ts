import { teamsPluginBase } from './base'

import { createAction } from './create.action'

export const teamsPlugin = teamsPluginBase.register(createAction)
