import { defineAction, Rest, useResponse } from 'server:core'

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
    function* () {
      const res = yield* useResponse()
      res.meta['Content-Type'] = 'text/html; charset=utf-8'
      return (yield* SwaggerHtmlRef.get()) ?? ''
    },
  )
