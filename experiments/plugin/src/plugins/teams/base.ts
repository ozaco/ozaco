import { createPlugin } from '@ozaco/std/plugin'
import type { usersPlugin } from '../users'

export const teamsPluginBase = createPlugin({
  name: 'teams',
  version: '0.0.0',
}).depends<'users', typeof usersPlugin>()
