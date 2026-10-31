import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

type Manifest = {
  manifest_version: number;
  name: string;
  minimum_chrome_version: string;
  permissions: string[];
  host_permissions: string[];
  action: object;
  side_panel: { default_path: string };
  externally_connectable?: object;
  content_scripts: [{ matches: string[]; run_at: string; all_frames?: boolean }];
  icons: Record<string, string>;
};

describe('built manifest', () => {
  let manifest: Manifest;

  beforeAll(() => {
    execSync('npx wxt build', { stdio: 'pipe' });
    manifest = JSON.parse(readFileSync('dist/chrome-mv3/manifest.json', 'utf8'));
  }, 120_000);

  it('identifies the extension and its minimum browser', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('Sum it up!');
    expect(manifest.minimum_chrome_version).toBe('141');
  });

  it('asks only for the permissions the extension uses', () => {
    expect([...manifest.permissions].sort()).toEqual(['scripting', 'sidePanel', 'storage']);
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
  });

  it('has a toolbar action and a side panel page', () => {
    expect(manifest.action).toBeDefined();
    expect(manifest.side_panel.default_path).toBe('sidepanel.html');
  });

  it('runs one content script at idle in the top frame of every site', () => {
    expect(manifest.content_scripts).toHaveLength(1);
    const [script] = manifest.content_scripts;
    expect(script.matches).toEqual(['<all_urls>']);
    expect(script.run_at).toBe('document_idle');
    expect(script.all_frames ?? false).toBe(false);
  });

  it('declares an icon at each size Chrome and the store use', () => {
    expect(Object.keys(manifest.icons).sort()).toEqual(['128', '16', '32', '48']);
  });

  it('accepts no messages from web pages', () => {
    expect(manifest.externally_connectable).toBeUndefined();
  });
});
