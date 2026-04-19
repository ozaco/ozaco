import { Router } from 'server:core'
import { defineService, useSelf } from 'server:service'

import { create } from './create'
import { custom } from './custom'
import { get } from './get'

export const TodoService = defineService({
  name: 'todo',
  version: '0.0.1',
  actions: {
    get,
    create,
    custom,
  },

  *setup() {
    yield* Router.actions.mount('/todo', yield* useSelf())

    console.log('todo: up')
  },
})
