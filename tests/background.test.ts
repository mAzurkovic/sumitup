import { beforeEach, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import background from '../src/entrypoints/background';

const setOptions = vi.fn();

beforeEach(() => {
  fakeBrowser.reset();
  setOptions.mockReset();
  Object.assign(fakeBrowser, { sidePanel: { setOptions } });
});

it('disables the side panel on every worker start, since the setting does not survive a browser restart', () => {
  background.main();
  expect(setOptions).toHaveBeenCalledExactlyOnceWith({ enabled: false });
});

it('disables the side panel again when the browser starts', async () => {
  background.main();
  setOptions.mockClear();
  await fakeBrowser.runtime.onStartup.trigger();
  expect(setOptions).toHaveBeenCalledExactlyOnceWith({ enabled: false });
});
