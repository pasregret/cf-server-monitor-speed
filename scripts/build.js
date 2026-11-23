#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const distDir = path.join(rootDir, 'dist');

console.log('Cleaning dist directory...');
if (fs.existsSync(distDir)) {
  fs.removeSync(distDir);
}

console.log('Building frontend...');
execSync('npx vite build --manifest', { cwd: rootDir, stdio: 'inherit' });

// Bundle a tiny, dependency-free-at-runtime inline entry. Do not load the app's
// dev config (and its mkcert plugin) during this secondary production build.
const bootstrap = await build({
  configFile: false, logLevel: 'silent',
  build: { write: false, emptyOutDir: false, minify: 'esbuild',
    lib: { entry: path.join(rootDir, 'src/frontend/bootstrap.js'), name: 'CFSMBootstrap', formats: ['iife'] }
  }
});
const bootstrapOutput = Array.isArray(bootstrap) ? bootstrap[0] : bootstrap;
const bootstrapCode = bootstrapOutput.output.find(file => file.type === 'chunk').code;
const manifestPath = path.join(distDir, '.vite/manifest.json');
const manifest = fs.readJsonSync(manifestPath);
const preloads = new Set();
const collectImports = (key) => {
  const chunk = manifest[key];
  if (!chunk || preloads.has(chunk.file)) return;
  preloads.add(chunk.file);
  for (const child of chunk.imports || []) collectImports(child);
};
collectImports(Object.keys(manifest).find(key => key.endsWith('/Dashboard.vue')));
const assetBase = (process.env.VITE_BASE || '/').replace(/\/?$/, '/');
const preloadData = JSON.stringify([...preloads].map(file => assetBase + file)).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const htmlFile = path.join(distDir, 'index.html');
const inline = `<script data-cfsm-preload="${preloadData}">${bootstrapCode.replace(/<\/script/gi, '<\\/script')}</script>\n`;
fs.writeFileSync(htmlFile, fs.readFileSync(htmlFile, 'utf8').replace(/<script type="module"/, inline + '<script type="module"'));
fs.removeSync(manifestPath);

console.log('Copying static assets...');
if (fs.existsSync(publicDir)) {
  fs.copySync(publicDir, distDir, { overwrite: false });
  console.log('Copied all static assets');
}

// 重命名为 dashboard.html，避免 ASSETS 直接拦截首页
const indexHtmlPath = path.join(distDir, 'index.html');
const dashboardHtmlPath = path.join(distDir, 'dashboard.html');
if (fs.existsSync(indexHtmlPath)) {
  fs.renameSync(indexHtmlPath, dashboardHtmlPath);
  console.log('Renamed index.html → dashboard.html');
}

console.log('Build complete!');
