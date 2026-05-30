import type { PolicyDef } from 'server:core'

import { RetryPolicy } from './definition'

export const getSelf = (): PolicyDef => RetryPolicy
