import { createTags } from 'std:shared'

/** The observe service's own failures — everything else surfaces the store's tags. */
export const ObserveErrors = createTags('observe', 'not-found', 'taken')
