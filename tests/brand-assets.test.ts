import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PNG_COLOR_TYPE_RGBA = 6;

describe('toolbar icons', () => {
  it.each([16, 32, 48, 128])('%ipx icon has that size and an alpha channel', (size) => {
    const png = readFileSync(`public/icon/${size}.png`);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    expect(png[25]).toBe(PNG_COLOR_TYPE_RGBA);
  });
});

describe('logo', () => {
  it('draws white lines and a green dot on a deep green square', () => {
    const svg = readFileSync('src/assets/logo.svg', 'utf8');
    expect(svg).toContain('fill="#166534"');
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('fill="#86efac"');
  });
});

describe('theme', () => {
  const css = readFileSync('src/lib/theme.css', 'utf8');
  const [light = '', dark = ''] = css.split('@media (prefers-color-scheme: dark)');

  it.each([
    ['--bg', '#ffffff', '#18181b'],
    ['--text', '#18181b', '#f4f4f5'],
    ['--muted', '#71717a', '#a1a1aa'],
    ['--line', '#e4e4e7', '#2e2e33'],
    ['--soft', '#f4f4f5', '#27272a'],
    ['--accent', '#166534', '#86efac'],
  ])('%s has its light and dark value', (name, lightValue, darkValue) => {
    expect(light).toContain(`${name}: ${lightValue};`);
    expect(dark).toContain(`${name}: ${darkValue};`);
  });

  it('tells the browser both color schemes are supported', () => {
    expect(light).toContain('color-scheme: light dark;');
  });

  it('reaches both extension pages and shadow roots', () => {
    expect(css.match(/:root,\s*:host/g)).toHaveLength(2);
  });
});
