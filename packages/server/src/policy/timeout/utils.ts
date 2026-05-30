import type { PolicyDef } from 'server:core'

import { TimeoutPolicy } from './definition'

export const getSelf = (): PolicyDef => TimeoutPolicy
