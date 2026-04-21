import { Rest } from 'server:core'
import type { ActionContext } from 'server:service'
import { defineAction } from 'server:service'

import { SpecRef, SwaggerHtmlRef } from './contexts'

export const createOpenAPIAction = (path: string) =>
  defineAction(
    {
      title: 'openapi',
      settings: [Rest.actions.settings({ method: 'GET', path })],
    },
    function* () {
      return (yield* SpecRef.get()) ?? {}
    },
  )

export const createSwaggerAction = (path: string) =>
  defineAction(
    {
      title: 'swagger',
      settings: [Rest.actions.settings({ method: 'GET', path })],
    },
    function* (ctx: ActionContext<unknown>) {
      ctx.res.meta['Content-Type'] = 'text/html; charset=utf-8'
      return (yield* SwaggerHtmlRef.get()) ?? ''
    },
  )
