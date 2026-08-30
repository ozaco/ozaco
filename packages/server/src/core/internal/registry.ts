// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { ServerErrors } from '../errors'
import type { ServerDef } from '../types/server'
import type { ServiceDef } from '../types/service'
import { isSocketAction } from '../utils/service'
import { isPartsDecl, isStreamDecl } from '../utils/stream'
import { validate } from '../utils/validation'

/** `service.action` — the registry key and the manifest id of one action. */
export const actionKey = (service: string, action: string): string => `${service}.${action}`

/**
 * Register a PLUGIN's service into a built registry (`PluginContext.services`) — the one
 * sanctioned mutation of the registry maps, so a plugin never reaches into them itself. The
 * service is hosted locally (never served over the carrier).
 */
export function* registerService(
  kernel: ServerDef.Context,
  def: ServiceDef.Service,
): Operation<void> {
  if (kernel.registry.services.has(def.name)) {
    return yield* fail(
      ServerErrors.Configuration,
      `a service named "${def.name}" is already declared`,
    )
  }

  ;(kernel.registry.services as Map<string, ServiceDef.Service>).set(def.name, def)

  for (const [name, entry] of Object.entries(def.actions)) {
    if (isSocketAction(entry)) {
      ;(kernel.registry.sockets as ServiceDef.ServiceSocket[]).push({
        ...entry.socket,
        service: def.name,
        handler: entry.handler,
      })
      continue
    }

    ;(kernel.registry.actions as Map<string, ServiceDef.Action>).set(
      actionKey(def.name, name),
      entry,
    )
  }

  kernel.hosted.add(def.name)
}

/** Build the registry from the declared services; duplicate names are a configuration failure. */
export function* buildRegistry(
  services: readonly ServiceDef.Service[],
): Operation<ServerDef.Registry> {
  const byName = new Map<string, ServiceDef.Service>()
  const actions = new Map<string, ServiceDef.Action>()
  const sockets: ServiceDef.ServiceSocket[] = []

  for (const def of services) {
    if (byName.has(def.name)) {
      return yield* fail(ServerErrors.Configuration, `service "${def.name}" is declared twice`)
    }

    byName.set(def.name, def)

    for (const [name, def2] of Object.entries(def.actions)) {
      if (isSocketAction(def2)) {
        sockets.push({ ...def2.socket, service: def.name, handler: def2.handler })
        continue
      }

      actions.set(actionKey(def.name, name), def2)
    }
  }

  return { services: byName, actions, sockets }
}

const brandOfDecl = (declaration: ServiceDef.Declaration | null): string | null => {
  if (declaration && isStreamDecl(declaration)) {
    return declaration.brand
  }

  if (declaration && isPartsDecl(declaration)) {
    return 'parts'
  }

  return null
}

export const manifestOf = (kernel: ServerDef.Context): ServerDef.Manifest => ({
  name: kernel.name,
  version: kernel.version,
  instance: kernel.instance,
  actions: [...kernel.registry.actions].map(([key, def]) => {
    const [service, action] = key.split('.') as [string, string]
    return {
      service,
      action,
      kind: def.meta.kind,
      route: def.meta.route,
      inputPlane: def.meta.inputPlane,
      outputPlane: def.meta.outputPlane,
      inputBrand: brandOfDecl(def.meta.input),
      outputBrand: brandOfDecl(def.meta.output),
      errors: def.meta.errors,
      tags: def.meta.tags,
      title: def.meta.title,
      description: def.meta.description,
    }
  }),
})

/** Every plugin option on every action must be owned by an installed plugin and pass its
 * validator — an option nobody handles is a typo, not a feature. */
export function* validateOptions(kernel: ServerDef.Context): Operation<void> {
  for (const [key, def] of kernel.registry.actions) {
    for (const [option, value] of Object.entries(def.meta.options)) {
      const schema = kernel.options.get(option)

      if (!schema) {
        return yield* fail(
          ServerErrors.Configuration,
          `action "${key}" sets option "${option}" but no installed plugin handles it`,
        )
      }

      const verdict = yield* attempt(() => validate(schema, value, `option "${option}"`))

      if (isFailure(verdict)) {
        return yield* fail(
          ServerErrors.Configuration,
          `action "${key}" option "${option}" is invalid`,
          ...verdict.causes,
        )
      }
    }
  }
}
