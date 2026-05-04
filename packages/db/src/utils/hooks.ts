import { useContext } from 'std:effect'

import { DB } from '../definition'

export const useDatabase = () => useContext(DB.context)
