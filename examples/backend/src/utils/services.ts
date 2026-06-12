import { AiService } from '../services/ai'
import { AuthService } from '../services/auth'
import { TodoService } from '../services/todo'

/** The app's API surface — `createClient` infers its types straight from `typeof services`. */
export const services = { auth: AuthService, todos: TodoService, ai: AiService }
export type Services = typeof services
