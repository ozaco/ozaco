import { fail } from 'std:result'

import { SERVICE } from '../const'
import { CoreErrors } from '../errors'
import type { ActionMap, Service, ServiceConfig } from '../types/service'

import { isAction } from './is'

/**
 * Defines a service: a named, versioned bag of actions plus optional `setup` that runs when the
 * service is registered on a broker. Address it typed (by object) or dynamically (by name).
 */
export const defineService = <const TActions extends ActionMap>(
  config: ServiceConfig<TActions>,
): Service<TActions> => {
  if (!config.name) {
    throw fail(CoreErrors.Configuration, 'a service requires a non-empty name')
  }

  for (const [key, action] of Object.entries(config.actions)) {
    if (!isAction(action)) {
      throw fail(
        CoreErrors.Configuration,
        `service "${config.name}" action "${key}" is not a defineAction result`,
      )
    }
  }

  return {
    _t: SERVICE,
    name: config.name,
    version: config.version ?? '0.0.0',
    description: config.description,
    actions: config.actions,
    events: config.events ?? {},
    setup: config.setup,
  }
}
