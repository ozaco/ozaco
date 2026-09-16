// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { ServerErrors } from '../errors'
import type { EdgeDef } from '../types/edge'
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
  kernel.pluginServices.add(def.name)
}

/** The manifest entry of a socket declared inside a service. */
export const socketInfoOf = (socket: ServiceDef.ServiceSocket): EdgeDef.SocketInfo => ({
  path: socket.path,
  service: socket.service,
  protocol: socket.protocol,
  description: socket.description,
  authorizeMode: socket.authorizeMode,
  defaults: socket.defaults,
  receives: socket.receives,
  sends: socket.sends,
})

/**
 * Swap the APPLICATION's declarations for `services` — the kernel's registry maps are mutated
 * in place (every layer reads `kernel.registry` on each dispatch/request, so nothing holds a
 * stale copy), plugin-registered services are carried over untouched, and `kernel.sockets`
 * (the manifest's socket list) is refreshed for the declared sockets. Atomic: the new registry
 * is built and validated first; a failure leaves the running one as it was.
 */
export function* reloadRegistry(
  kernel: ServerDef.Context,
  services: readonly ServiceDef.Service[],
): Operation<ServerDef.ReloadReport> {
  for (const def of services) {
    if (kernel.pluginServices.has(def.name)) {
      return yield* fail(
        ServerErrors.Configuration,
        `service "${def.name}" is registered by a plugin and cannot be reloaded`,
      )
    }
  }

  const kept = [...kernel.registry.services.values()].filter(def =>
    kernel.pluginServices.has(def.name),
  )
  const next = yield* buildRegistry([...kept, ...services])
  yield* validateOptions(kernel, next)

  const before = new Set(
    [...kernel.registry.services.keys()].filter(name => !kernel.pluginServices.has(name)),
  )
  const now = new Set(services.map(def => def.name))
  const report: ServerDef.ReloadReport = {
    added: [...now].filter(name => !before.has(name)),
    removed: [...before].filter(name => !now.has(name)),
    replaced: [...now].filter(name => before.has(name)),
    actions: next.actions.size,
    sockets: next.sockets.length,
  }

  // --- the swap: synchronous from here, no yield until the maps agree again ----------------
  const servicesMap = kernel.registry.services as Map<string, ServiceDef.Service>
  const actionsMap = kernel.registry.actions as Map<string, ServiceDef.Action>
  const socketsList = kernel.registry.sockets as ServiceDef.ServiceSocket[]
  const declared = new Set(socketsList.filter(socket => !kernel.pluginServices.has(socket.service)))
  servicesMap.clear()
  actionsMap.clear()
  socketsList.length = 0

  for (const [name, def] of next.services) {
    servicesMap.set(name, def)
  }

  for (const [key, def] of next.actions) {
    actionsMap.set(key, def)
  }

  socketsList.push(...next.sockets)

  // the manifest's socket list: drop the infos of the sockets the old declarations had, keep
  // what the edge registered directly (`Edge.actions.socket`), add the new declarations'
  const stale = new Set([...declared].map(socket => `${socket.service} ${socket.path}`))
  const external = kernel.sockets.filter(info => !stale.has(`${info.service ?? ''} ${info.path}`))
  kernel.sockets.length = 0
  kernel.sockets.push(...external)

  for (const socket of next.sockets) {
    if (!kernel.pluginServices.has(socket.service)) {
      kernel.sockets.push(socketInfoOf(socket))
    }
  }

  return report
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
 * validator — an option nobody handles is a typo, not a feature. `registry` defaults to the
 * kernel's own (a reload validates the candidate before swapping it in). */
export function* validateOptions(
  kernel: ServerDef.Context,
  registry: ServerDef.Registry = kernel.registry,
): Operation<void> {
  for (const [key, def] of registry.actions) {
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
