import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on the browser SDK's init/getData BEFORE importing the react wrapper, so
// the wrapper closes over the mocked module-level functions.
vi.mock('../src/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/index')>();
  return {
    ...actual,
    init: vi.fn(actual.init),
    getData: vi.fn(actual.getData),
  };
});

import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AffitorProvider, useAffitor } from '../src/react';
import * as sdk from '../src/index';

// Required so React's `act()` runs in test mode under jsdom.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.removeChild(container);
  vi.restoreAllMocks();
});

describe('AffitorProvider', () => {
  it('renders children and calls init() once on mount with the given options', () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          AffitorProvider,
          { programId: 123, apiBase: 'https://api.test', debug: true },
          createElement('span', null, 'child-content'),
        ),
      );
    });

    expect(container.textContent).toContain('child-content');
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.init).toHaveBeenCalledWith({
      programId: 123,
      apiBase: 'https://api.test',
      debug: true,
      cookieDomain: undefined,
    });

    act(() => root.unmount());
  });
});

describe('useAffitor', () => {
  it('exposes signup + getClickId delegating to the browser SDK', () => {
    let captured: ReturnType<typeof useAffitor> | null = null;
    function Probe() {
      captured = useAffitor();
      return null;
    }

    const root = createRoot(container);
    act(() => {
      root.render(createElement(AffitorProvider, { programId: 1 }, createElement(Probe)));
    });

    expect(captured).not.toBeNull();
    expect(typeof captured!.signup).toBe('function');
    expect(typeof captured!.getClickId).toBe('function');
    expect(captured!.signup).toBe(sdk.signup);
    expect(captured!.getClickId).toBe(sdk.getClickId);

    act(() => root.unmount());
  });
});
