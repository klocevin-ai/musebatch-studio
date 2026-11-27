import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const bundlePath = path.join(distDir, 'bundle.cjs');
const seaConfigPath = path.join(distDir, 'sea-config.json');
const exePath = path.join(distDir, 'MuseBatchStudio.exe');

fs.mkdirSync(distDir, { recursive: true });

console.log('[1/3] Bundling backend + node_modules into single CommonJS file with esbuild...');
await esbuild.build({
  entryPoints: [path.join(rootDir, 'server', 'index.js')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: bundlePath,
  minify: false,
  logLevel: 'info',
  // Ignore optional native ws addons if referenced dynamically
  external: ['bufferutil', 'utf-8-validate']
});

console.log('[2/3] Writing Node.js SEA config with embedded web UI assets...');
const seaConfig = {
  main: bundlePath,
  output: exePath,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: {
    'index.html': path.join(rootDir, 'public', 'index.html'),
    'styles.css': path.join(rootDir, 'public', 'styles.css'),
    'app.js': path.join(rootDir, 'public', 'app.js')
  }
};
fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2), 'utf8');

console.log('[3/3] Building standalone Windows executable via node --build-sea...');
execFileSync(process.execPath, ['--build-sea', seaConfigPath], {
  cwd: rootDir,
  stdio: 'inherit'
});

const sizeMb = (fs.statSync(exePath).size / (1024 * 1024)).toFixed(1);
console.log(`\nSUCCESS! Built single-file executable:\n  ${exePath} (${sizeMb} MB)\n`);
