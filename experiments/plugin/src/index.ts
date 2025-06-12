import './definition'
import '@ozaco/std/effects'

import { logger } from './consts'
import { usersPlugin } from './plugins/users'
import { teamsPlugin } from './plugins/teams'

const users = usersPlugin()
const teams = teamsPlugin()

const team1 = teams.create.one('alice')

if (team1.isErr()) {
  const cs = teams.tags.has(team1.name)
  logger.err('team1', team1)
}

logger.log('teams')

export * from './consts'
export * from './tag'
