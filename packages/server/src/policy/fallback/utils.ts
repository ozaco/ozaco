import type { PolicyDef } from 'server:core'

import { FallbackPolicy } from './definition'

export const getSelf = (): PolicyDef => FallbackPolicy
