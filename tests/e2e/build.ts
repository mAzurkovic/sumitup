import { execSync } from 'node:child_process';

/** Builds the extension with its provider address pointed at the fake provider. */
export default function buildTestExtension() {
  execSync('npx wxt build --mode test', { stdio: 'inherit' });
}
