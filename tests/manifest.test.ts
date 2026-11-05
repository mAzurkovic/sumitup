import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

type Manifest = {
  manifest_version: number;
  name: string;
  minimum_chrome_version: string;
  permissions: string[];
  host_permissions: string[];
  action: object;
  side_panel?: object;
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

  it('has a toolbar action and a panel page, but no panel on every tab by default', () => {
    expect(manifest.action).toBeDefined();
    expect(manifest.side_panel).toBeUndefined();
    expect(existsSync('dist/chrome-mv3/sidepanel.html')).toBe(true);
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

  it('keeps the article reader out of the script that loads on every page', () => {
    const readerMarker = '_grabArticle';
    expect(readFileSync('dist/chrome-mv3/extract.js', 'utf8')).toContain(readerMarker);
    expect(readFileSync('dist/chrome-mv3/content-scripts/content.js', 'utf8')).not.toContain(readerMarker);
  });
});

/** All script text of a build, so a test can check which hosts it can reach. */
const scriptsOf = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(`${dir}/${file}`, 'utf8'))
    .join('\n');

describe('provider hosts in the build', () => {
  it('reaches only the real provider host in a production build', () => {
    execSync('npx wxt build', { stdio: 'pipe' });
    const scripts = scriptsOf('dist/chrome-mv3');
    expect(scripts).toContain('https://api.anthropic.com/v1');
    expect(scripts).not.toMatch(/127\.0\.0\.1|localhost/);
  }, 120_000);

  it('reaches the local fake provider in a test build', () => {
    execSync('npx wxt build --mode test', { stdio: 'pipe' });
    expect(scriptsOf('dist/chrome-mv3-test')).toContain('http://127.0.0.1:4319/v1');
  }, 120_000);
});
