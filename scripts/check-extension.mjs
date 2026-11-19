import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertFile(relativePath) {
  assert(existsSync(resolve(root, relativePath)), `Manifest file is missing: ${relativePath}`);
}

assert(manifest.manifest_version === 3, 'Expected a Manifest V3 extension.');
for (const permission of ['storage', 'scripting', 'tabs']) {
  assert(manifest.permissions.includes(permission), `Missing permission: ${permission}`);
}
assert(manifest.host_permissions?.includes('<all_urls>'), 'Expected all-sites access for media detection.');

const scripts = [
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((contentScript) => contentScript.js),
  'popup.js',
];
for (const script of new Set(scripts)) {
  assertFile(script);
  const result = spawnSync(process.execPath, ['--check', resolve(root, script)], { encoding: 'utf8' });
  assert(result.status === 0, `JavaScript syntax check failed for ${script}:\n${result.stderr}`);
}

for (const [size, iconPath] of Object.entries(manifest.icons)) {
  assertFile(iconPath);
  const png = readFileSync(resolve(root, iconPath));
  assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${iconPath} is not a PNG.`);
  assert(png.readUInt32BE(16) === Number(size) && png.readUInt32BE(20) === Number(size),
    `${iconPath} must be ${size}x${size}.`);
}

assertFile(manifest.action.default_popup);
console.log('Extension manifest, JavaScript syntax, and icon assets are valid.');
