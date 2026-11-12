#!/usr/bin/env node
// Cross-platform wrapper for environment-driven test modes.
//   node scripts/test-preview.mjs [playwright args]      run the suite against the production build
//   node scripts/test-preview.mjs --dev --headed [...]   dev server, visible browser
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const env = { ...process.env };
const take = (flag) => {
  const i = args.indexOf(flag);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
if (!take('--dev')) env.LUMEN_PREVIEW = '1';
if (take('--headed')) env.HEADED = '1';
const child = spawn('npx', ['playwright', 'test', ...args], { stdio: 'inherit', env, shell: true });
child.on('exit', (code) => process.exit(code ?? 1));
