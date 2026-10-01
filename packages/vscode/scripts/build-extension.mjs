import { build, context, transform } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolveBunExecutable } from '../../../scripts/lib/bun-executable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webManifest = path.resolve(root, '../web/package.json');
const embeddedPackages = ['@opencode/core', '@opencode/server', '@opencode-ai/pty', 'effect'];
const modules = path.join(root, 'dist/node_modules');
const installed = new Map();

// Lower published resource-management syntax for the Node 22 extension host,
// retaining conditional module resolution and physical native/WASM paths.
async function lowerResourceManagement(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') await lowerResourceManagement(filename);
    } else if (/\.(?:c|m)?js$/u.test(entry.name)) {
      const source = await fs.readFile(filename, 'utf8');
      if (!/\b(?:await\s+)?using\s+\w+\s*=/u.test(source)) continue;
      const output = await transform(source, { loader: 'js', target: 'node22', sourcefile: filename });
      await fs.writeFile(filename, output.code);
    }
  }
}

async function stage(name, from, parentModules = modules, optional = false) {
  const require = createRequire(from);
  let source;
  for (const directory of require.resolve.paths(name) ?? []) {
    const candidate = path.join(directory, name);
    try {
      await fs.access(path.join(candidate, 'package.json'));
      source = await fs.realpath(candidate);
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!source) {
    if (optional) return;
    throw new Error(`Missing embedded engine dependency: ${name} (from ${from})`);
  }
  const manifestPath = path.join(source, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const top = path.join(modules, name);
  const destination = installed.has(top) && installed.get(top) !== source ? path.join(parentModules, name) : top;
  if (installed.get(destination) === source) return;
  if (installed.has(destination)) throw new Error(`Conflicting dependency at ${destination}`);
  installed.set(destination, source);
  await fs.cp(source, destination, { recursive: true, dereference: true, filter: (entry) => entry === source || path.basename(entry) !== 'node_modules' });
  await lowerResourceManagement(destination);
  const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies };
  for (const dependency of Object.keys(dependencies)) {
    await stage(dependency, manifestPath, path.join(destination, 'node_modules'),
      dependency in (manifest.optionalDependencies ?? {}) || dependency in (manifest.peerDependencies ?? {}));
  }
}

// Universal VSIX must include optional native binaries for all supported hosts.
execFileSync(resolveBunExecutable(), ['install', '--frozen-lockfile', '--ignore-scripts', '--os', '*', '--cpu', '*'], {
  cwd: path.resolve(root, '../..'), stdio: 'inherit',
});
await fs.rm(modules, { recursive: true, force: true });
for (const name of embeddedPackages) await stage(name, webManifest);
const options = {
  absWorkingDir: root, entryPoints: ['src/extension.ts'], bundle: true, outfile: 'dist/extension.js',
  external: ['vscode', ...embeddedPackages.map((name) => `${name}/*`), ...embeddedPackages],
  format: 'cjs', platform: 'node', mainFields: ['module', 'main'],
  minify: !process.argv.includes('--watch'), sourcemap: process.argv.includes('--watch'),
};
if (process.argv.includes('--watch')) { const watcher = await context(options); await watcher.watch(); }
else await build(options);
