import { operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import { Broker, Gateway } from '../definitions'
import type { Role } from '../types/role'
import type { Service } from '../types/service'

import { RoleContext } from './context'

/**
 * Ask whoever is orchestrating this process what to do with `name`, so a self-wiring service never has
 * to be told. The daemon publishes a resolver into {@link RoleContext}; with one installed, `SERVICE=notes`
 * makes a resource called `notes` own itself and mount nothing, a gateway mount it and own nothing, and
 * a monolith do both.
 *
 * With no orchestrator there is no split to honour, so the answer is the classic one: own it, and serve
 * it if there is a gateway to serve it on. Every existing single-process app is unchanged.
 *
 * Pass `service` when the caller might ALSO be listed as a daemon module — the daemon wires those
 * itself, and this returns all-false so the two cannot double-register.
 */
export const useRole = operation(function* (name: string, service?: Service) {
  const gateway = (yield* Gateway.context.get()) !== undefined
  const resolver = yield* RoleContext.get()

  if (!resolver) {
    return { own: true, serve: gateway } satisfies Role
  }
  if (service !== undefined && resolver.managed(service)) {
    return { own: false, serve: false } satisfies Role
  }

  return { own: resolver.owns(name), serve: gateway && resolver.serves() } satisfies Role
})

/**
 * Wire a service or socket into this process, if the caller asked for it.
 *
 * Opt-in: `install(x)` alone still does nothing implicit, so nothing that exists today changes.
 * `install(x, { mount: '/chat' })` replaces the register + mount pair — and splits correctly by
 * itself, because {@link useRole} decides separately whether this process RUNS the thing and whether
 * it SERVES its routes. On a gateway that is mount-only; in a headless pod, register-only.
 */
export const autoWire = function* (target: AnyType, options: { mount?: string } | undefined) {
  if (!options) {
    return
  }

  const { own, serve } = yield* useRole(target.name, target)

  if (own) {
    yield* Broker.actions.register(target)
  }
  if (serve && options.mount !== undefined && (yield* Gateway.context.get()) !== undefined) {
    yield* Gateway.actions.mount(options.mount, target)
  }
}
