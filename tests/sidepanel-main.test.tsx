// @vitest-environment happy-dom
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const connect = vi.fn(() => ({
  onMessage: { addListener: vi.fn() },
  onDisconnect: { addListener: vi.fn() },
  postMessage: vi.fn(),
  disconnect: vi.fn(),
}));

async function openAt(search: string) {
  history.replaceState(null, '', `/sidepanel.html${search}`);
  await act(() => import('../src/entrypoints/sidepanel/main'));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="root"></div>';
  Object.assign(fakeBrowser.runtime, { connect });
});

describe('panel page', () => {
  it('connects for the tab named in its address', async () => {
    await openAt('?tabId=42');
    expect(connect).toHaveBeenCalledExactlyOnceWith({ name: 'panel:42' });
  });

  it.each(['', '?tabId=', '?tabId=abc', '?tabId=4.2'])('stays empty for %j', async (search) => {
    await openAt(search);
    expect(connect).not.toHaveBeenCalled();
  });
});
