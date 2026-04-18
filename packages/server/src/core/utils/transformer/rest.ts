import { operation, withHost } from 'std:effect'
import { defineNamespace } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Request } from 'server:service'

import { REST_TRANSFORMER, TransformerTags } from '../../const'
import type { Helpers } from '../../types/helpers'
import type { RestTransformerActions, RestTransformerContext } from '../../types/transformer'

// oxlint-disable-next-line import/exports-last
export const RestTransformer = defineNamespace<
  RestTransformerContext,
  unknown,
  [],
  RestTransformerActions
>({
  name: 'rest-transformer',
  version: '0.0.1',
  subtype: REST_TRANSFORMER,
})

const RestDef = RestTransformer.implement({
  name: 'default-rest-transforme',
  version: '0.0.1',

  // oxlint-disable-next-line require-yield
  *setup() {
    return {}
  },
})

export const Rest: Helpers.DefaultRestTransformer = RestDef.build({
  parse: operation(function* (req: AnyType, _res: AnyType) {
    return yield* withHost({
      // oxlint-disable-next-line require-yield
      *bun() {
        return {
          method: req.method,
          url: req.url,

          meta: {},
          files: {},
          body: {},

          raw: req,
          rawBody: null as AnyType,
        } satisfies Request
      },
      *node() {
        return yield* fail('unexpected-runtime')
      },
      *deno() {
        return yield* fail('unexpected-runtime')
      },
      *browser() {
        return yield* fail('unexpected-runtime')
      },
    })
  }, TransformerTags.parse),
})
