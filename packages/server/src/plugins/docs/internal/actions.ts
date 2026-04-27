import type { ActionContext } from 'server:core'
import { defineAction, RestTransformer } from 'server:core'

import { SpecRef, SwaggerHtmlRef } from './contexts'

export const createOpenAPIAction = (path: string) =>
  defineAction(
    {
      title: 'openapi',
      settings: [RestTransformer.actions.settings({ method: 'GET', path })],
    },
    function* () {
      return (yield* SpecRef.get()) ?? {}
    },
  )

export const createSwaggerAction = (path: string) =>
  defineAction(
    {
      title: 'swagger',
      settings: [RestTransformer.actions.settings({ method: 'GET', path })],
    },
    function* (ctx: ActionContext<unknown>) {
      ctx.res.meta['Content-Type'] = 'text/html; charset=utf-8'
      return (yield* SwaggerHtmlRef.get()) ?? ''
    },
  )
