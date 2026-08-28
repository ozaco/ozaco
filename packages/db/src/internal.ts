/**
 * `@ozaco/db/internal` — the plumbing an ADAPTER or a KV store is built on: the protocol
 * defaults, the in-memory evaluators, the spec helpers and the shared symbols.
 *
 * Application code never needs any of it — `@ozaco/db` (table / column / where / useDb /
 * DbClient) is the whole surface for using a database. Reach in here when you are writing a
 * `DbAdapter` or a `Kv` impl of your own.
 */
export {
  CHANGES_PREFIX,
  COLUMN,
  COLUMN_NAME,
  DATABASE,
  DATABASE_ADAPTER,
  DEFAULT_BUS_TOPIC,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_KV_PREFIX,
  DEFAULT_MAX_PENDING,
  DEFAULT_ORDER,
  DEFAULT_REPLAY_WINDOW_MS,
  KV_STORE,
  TABLE,
  TABLE_NAME,
} from './core/const'
export { adapterDefaults } from './core/utils/adapter'
export { matches, sortDocs } from './core/utils/evaluate'
export { filterFields } from './core/utils/filter'
export { isDestructive, isSystemField, isTable } from './core/utils/is'
export { isValidKvPrefix, kvActions, kvDefaults } from './core/utils/kv'
export { tableSpecOf } from './core/utils/schema'
