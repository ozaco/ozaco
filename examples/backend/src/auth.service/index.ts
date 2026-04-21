import { Router } from 'server:core'
import { defineService, useSelf } from 'server:service'

import { me } from './me'
import { refresh } from './refresh'
import { signIn } from './sign-in'
import { signOut } from './sign-out'

export const AuthService = defineService({
  name: 'auth',
  version: '0.0.1',
  actions: {
    signIn,
    signOut,
    refresh,
    me,
  },

  *setup() {
    yield* Router.actions.mount('/auth', yield* useSelf())

    console.log('auth: up')
  },
})
