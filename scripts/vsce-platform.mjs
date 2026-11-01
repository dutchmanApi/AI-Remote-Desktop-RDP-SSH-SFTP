import { spawnSync } from 'node:child_process';

const targets = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'win32-arm64': 'win32-arm64',
  'win32-x64': 'win32-x64',
  'linux-arm64': 'linux-arm64',
  'linux-x64': 'linux-x64',
};

const target = targets[`${process.platform}-${process.arch}`];
const command = process.argv[2];

if (!target) {
  throw new Error(`No VSIX target is configured for ${process.platform}-${process.arch}.`);
}

if (command !== 'package' && command !== 'publish') {
  throw new Error(`Unsupported vsce command: ${command ?? '(missing)'}`);
}

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vsce', command, '--target', target],
  { stdio: 'inherit', shell: process.platform === 'win32' }
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
