import type { DaemonDef } from '../types'

// What this process should do with a given piece of the app. The daemon asks it per module, and it
// is also published through `RoleContext` so a self-wiring service reaches the same verdict.

/**
 * Does THIS process RUN the thing called `name`? An owner installs its plugins and registers its
 * service on the broker, which is what makes it reachable over the transport. The gateway owns
 * nothing — it must never boot a service it only routes to.
 */
export const ownsRole = (name: string, rt: DaemonDef.Runtime): boolean =>
  rt.kind === 'monolith' || (rt.kind === 'service' && rt.service === name)

/**
 * Does THIS process EXPOSE routes at all? The gateway serves everything — that is its whole job, and
 * why one edge still presents the complete API surface and OpenAPI spec. A monolith serves what it
 * runs; a service process serves nothing.
 */
export const servesRole = (rt: DaemonDef.Runtime): boolean =>
  rt.kind === 'gateway' || rt.kind === 'monolith'

export const owns = (module: DaemonDef.Module, rt: DaemonDef.Runtime): boolean =>
  (module.when === undefined || module.when(rt)) && ownsRole(module.name, rt)

export const serves = (module: DaemonDef.Module, rt: DaemonDef.Runtime): boolean => {
  if (module.service === undefined || module.route === undefined) {
    return false
  }
  // a monolith serves only what it runs, so a `when`-disabled module stays off the router there too
  return servesRole(rt) && (rt.kind !== 'monolith' || owns(module, rt))
}
