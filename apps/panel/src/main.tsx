// oxlint-disable import/no-unassigned-import -- the stylesheet entry
import { createRoot } from 'react-dom/client'

import { App } from './app'
import './styles.css'

createRoot(document.querySelector('#root')!).render(<App />)
