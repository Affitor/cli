/**
 * affitor-sdk/react — thin React wrapper over the browser SDK.
 *
 * A context provider that calls the browser `init()` once on mount and a
 * `useAffitor()` hook exposing the tracker snapshot plus `signup`/`getClickId`.
 * React is a PEER dependency — it is not bundled here.
 *
 * Usage:
 *   import { AffitorProvider, useAffitor } from 'affitor-sdk/react';
 *
 *   <AffitorProvider programId={123}>
 *     <App />
 *   </AffitorProvider>
 *
 *   const { data, signup, getClickId } = useAffitor();
 *
 * SSR-safe: the underlying `init()` is a no-op without `window`, so the provider
 * renders its children on the server without touching the DOM.
 */

import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  init,
  signup as sdkSignup,
  getClickId as sdkGetClickId,
  getData as sdkGetData,
} from './index';
import type { AffitorData } from './index';

export interface AffitorProviderProps {
  /** Affiliate program id. */
  programId?: number | string;
  /** Verbose console logging. */
  debug?: boolean;
  /** Override the tracking API base. Defaults to https://api.affitor.com. */
  apiBase?: string;
  /** Force a cookie domain (e.g. `.example.com`). Auto-detected when omitted. */
  cookieDomain?: string;
  children?: ReactNode;
}

export interface AffitorContextValue {
  data: AffitorData | null;
  signup: typeof sdkSignup;
  getClickId: typeof sdkGetClickId;
}

const AffitorContext = createContext<AffitorContextValue | null>(null);

/** Provider that initializes the browser tracker once on mount. */
export function AffitorProvider({
  programId,
  debug,
  apiBase,
  cookieDomain,
  children,
}: AffitorProviderProps) {
  const [data, setData] = useState<AffitorData | null>(null);

  useEffect(() => {
    // init() is a no-op on the server; on the client it (re)initializes the
    // module-level singleton and runs attribution synchronously.
    init({ programId, debug, apiBase, cookieDomain });
    setData(sdkGetData());
    // Re-run only when the configuration that affects init changes.
  }, [programId, debug, apiBase, cookieDomain]);

  const value: AffitorContextValue = {
    data,
    signup: sdkSignup,
    getClickId: sdkGetClickId,
  };

  return <AffitorContext.Provider value={value}>{children}</AffitorContext.Provider>;
}

/** Access the tracker snapshot and the signup/getClickId helpers. */
export function useAffitor(): AffitorContextValue {
  const ctx = useContext(AffitorContext);
  if (!ctx) {
    // Outside a provider the SDK still works (it falls back to the singleton),
    // so return a usable value rather than throwing.
    return { data: sdkGetData(), signup: sdkSignup, getClickId: sdkGetClickId };
  }
  return ctx;
}
