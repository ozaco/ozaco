import './definition'
import '@ozaco/std/effects'

import { logger } from './consts'
import { teamsPlugin } from './plugins/teams'
import { usersPlugin } from './plugins/users'

const users = await usersPlugin()
const teams = teamsPlugin().use('users', users)

const team1 = await teams.create.one('alice')

if (team1.isErr()) {
  const cs = teams.tags.has(team1.name)
  logger.err('team1', team1)
}

logger.log('teams')

export * from './consts'
export * from './tag'
