import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('never tracks the local key file', () => {
  expect(execSync('git check-ignore .env.local').toString().trim()).toBe('.env.local');
});

it('pins the build framework to one exact version', () => {
  const { devDependencies } = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(devDependencies.wxt).toBe('0.21.5');
});
