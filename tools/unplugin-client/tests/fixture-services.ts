import { defineAction, defineService, Gateway } from '@ozaco/server/core'

export const userService = defineService({
  name: 'users',
  version: '0.0.0',
  actions: {
    get: defineAction(
      { settings: [Gateway.actions.rest({ method: 'GET', path: '/:id' })] },
      function* () {
        return { id: '1' }
      },
    ),
    list: defineAction(
      { settings: [Gateway.actions.rest({ method: 'GET', path: '/' })] },
      function* () {
        return []
      },
    ),
  },

  *setup() {},
})

export const services = { users: userService }
export type Services = typeof services
