import { lexerPluginBase } from './base'

import { tokenizeAction } from './tokenize.action'
import { utilsAction } from './utils.action'

export const lexerPlugin = lexerPluginBase.register(tokenizeAction).register(utilsAction)
