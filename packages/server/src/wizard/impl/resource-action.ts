import { CoreStatusMap, defineAction, Gateway } from 'server:core'
import type { Action } from 'server:core'
import type { AnyType } from 'std:shared'

import { assertAccess } from '../internal/access'
import { resolveActionArgs } from '../internal/args'
import type { RealtimeTransport, UploadMetadata, WizardActionDef } from '../types'
import { normalizeUpload } from '../utils/upload'

interface BuildSpec {
  readonly namespace: string
  readonly name: string
  readonly definition: WizardActionDef
  /** The owning resource's realtime transport, if it has a realtime channel. */
  readonly realtime?: RealtimeTransport | undefined
}

export interface ResourceAction extends Action {
  readonly wizard: {
    readonly kind: WizardActionDef['kind']
    readonly upload?: UploadMetadata | undefined
    /** The reactive payload validator (`.watch(...)` onNext), when it differs from `returns`. */
    readonly emits?: WizardActionDef['emits']
    /** The resource's realtime transport, surfaced to Docs/codegen so the client picks it without a
     * runtime probe. Present only on resources that expose a realtime channel. */
    readonly realtime?: RealtimeTransport
  }
}

/** Convert one Wizard definition into a normal, plugin-bound server action. */
export const buildResourceAction = (spec: BuildSpec): ResourceAction => {
  const { namespace, name, definition, realtime } = spec
  const method = definition.rest?.method ?? 'POST'
  const path = definition.rest?.path ?? `/${name}`
  const upload = definition.upload ? normalizeUpload(definition.upload) : undefined
  const action = defineAction(
    {
      title: `${namespace}.${name}`,
      input: resolveActionArgs(definition),
      ...(definition.returns ? { output: definition.returns } : {}),
      settings: [
        Gateway.actions.rest({
          method,
          path,
          statusMap: CoreStatusMap,
          ...(upload
            ? { multipart: upload.mode, files: upload.fields.map(field => field.name) }
            : {}),
        }),
      ],
    },
    function* (body: AnyType) {
      yield* assertAccess(definition.access, { op: name, namespace, args: body })
      return yield* definition.handler(body)
    },
  )

  return Object.assign(action, {
    wizard: {
      kind: definition.kind,
      ...(upload ? { upload } : {}),
      ...(definition.emits ? { emits: definition.emits } : {}),
      ...(realtime ? { realtime } : {}),
    },
  })
}
