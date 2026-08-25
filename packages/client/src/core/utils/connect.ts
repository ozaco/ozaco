import { attempt, createFuture, createScope, suspend } from 'std:effect'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import type { ClientDef } from '../types/client'

import { createClient } from './client'

/**
 * `createClient` for promise land: ONE long-lived session task runs the client (its plugins
 * live in that task's scope), and the SAME handle comes back — every call is a `Future`
 * (awaitable), every stream a std `FutureFlow` (`for await`-able), so nothing else is needed.
 * `$close()` tears the session down.
 */
export const connectClient = async <TApi = Record<string, Record<string, ClientDef.Ref>>>(
  options: ClientDef.Options,
): Promise<ClientDef.ConnectedHandle<TApi>> => {
  const [scope, destroy] = createScope()
  const ready = createFuture<ClientDef.Handle<TApi>>()

  // the session task stays suspended: the client's contexts live in ITS scope and would be
  // torn down the moment the task completes — `$close` destroys the scope instead
  scope.run(
    function* () {
      const opened = yield* attempt(() => createClient<TApi>(options))

      if (isFailure(opened)) {
        ready.reject(opened)
        return
      }

      ready.resolve(opened.value)
      yield* suspend()
    },
    { detached: true },
  )

  const connected = unwrap(await ready.future) as AnyType
  connected.$close = () => Promise.resolve(destroy()).then(() => undefined)

  return connected as ClientDef.ConnectedHandle<TApi>
}
