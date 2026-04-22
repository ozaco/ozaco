import { Router } from 'server:core'
import { defineService, useSelf } from 'server:service'

import { create } from './create'
import { custom } from './custom'
import { get } from './get'
import { list } from './list'
import { rawFile } from './raw-file'

export const TodoService = defineService({
  name: 'todo',
  version: '0.0.1',
  actions: {
    get,
    list,
    create,
    custom,
    rawFile,
  },

  *setup() {
    yield* Router.actions.mount('/todo', yield* useSelf())

    console.log('todo: up')
  },
})
