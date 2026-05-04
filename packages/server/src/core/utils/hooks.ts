import { useContext } from 'std:effect'

import {
  ActionRawRequestContext,
  ActionRawResponseContext,
  ActionRequestContext,
  ActionResponseContext,
  ActionSignalContext,
} from '../internal/contexts'

export const useRequest = () => useContext(ActionRequestContext)
export const useResponse = () => useContext(ActionResponseContext)
export const useRawRequest = () => useContext(ActionRawRequestContext)
export const useRawResponse = () => useContext(ActionRawResponseContext)
export const useActionSignal = () => useContext(ActionSignalContext)
