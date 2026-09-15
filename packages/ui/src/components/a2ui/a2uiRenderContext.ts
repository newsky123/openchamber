import React from 'react';

import type { A2uiComponent, A2uiDataModel, A2uiJsonValue } from '@/lib/a2ui/protocol';

interface A2uiRenderContextValue {
  readonly components: ReadonlyMap<string, A2uiComponent>;
  readonly dataModel: A2uiDataModel;
  /** Writes what the user entered back to the path the control is bound to. */
  readonly writeValue: (path: string, value: A2uiJsonValue) => void;
  readonly runAction: (componentId: string) => void;
}

/**
 * Shared by one surface and every component inside it. The tree is recursive
 * and arbitrarily deep, so the data model and the two callbacks travel through
 * context instead of being threaded down each level.
 */
export const A2uiRenderContext = React.createContext<A2uiRenderContextValue | null>(null);

export const useA2uiRenderContext = (): A2uiRenderContextValue => {
  const value = React.useContext(A2uiRenderContext);
  if (!value) throw new Error('A2UI components must render inside A2uiSurfaceView');
  return value;
};
