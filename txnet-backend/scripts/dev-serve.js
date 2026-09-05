#!/usr/bin/env node
/**
 * Dev runner: one persistent webpack watch + one node process restarted on
 * each successful emit.
 *
 * `nx serve` (@nx/js:node) cannot be used for this loop: it spawns a *fresh*
 * `webpack-cli build` process on every file change — even when that target is
 * declared `continuous` and runs with `--watch` — so every save paid for a
 * cold webpack start (module graph + filesystem-cache deserialisation) before
 * a single byte was recompiled, and the killed watchers piled up as zombies.
 * Driving the compiler through the Node API keeps the module graph in memory,
 * which turns a save into an incremental rebuild.
 *
 * The child is restarted from webpack's `done` hook, i.e. after every asset is
 * fully written, so it can never load a half-written bundle. Usage:
 *
 *     APP_NAME=auth-service node scripts/dev-serve.js
 */
const path = require('path');
const { spawn } = require('child_process');
const webpack = require('webpack');

const appName = process.env.APP_NAME;
if (!appName) {
  console.error('dev-serve: APP_NAME is required (e.g. APP_NAME=auth-service)');
  process.exit(1);
}

const workspaceRoot = path.resolve(__dirname, '..');
const appDir = path.join(workspaceRoot, appName);

// Both webpack configs resolve their own paths from `__dirname`, but ts-loader
// and tsconfig `include` globs are relative to the cwd.
process.chdir(appDir);

const config = require(path.join(appDir, 'webpack.config.js'));
const outputDir = (config.output && config.output.path) || path.join(workspaceRoot, 'dist', appName);
const outputName = (config.output && config.output.filename) || 'main.js';
// A hashed/templated name has no single stable entry file to run.
const entryFile = path.join(outputDir, outputName.includes('[') ? 'main.js' : outputName);

let child = null;
let restarting = false;
let pendingRestart = false;

function spawnChild() {
  child = spawn(process.execPath, [entryFile], { stdio: 'inherit', env: process.env });
  child.on('exit', (code, signal) => {
    // A restart kills the child itself; only an unexpected exit is worth reporting.
    if (!restarting && signal !== 'SIGTERM') {
      console.error(`[dev-serve] ${appName} exited (code ${code}); waiting for the next change`);
    }
    child = null;
  });
}

function restart() {
  if (restarting) {
    pendingRestart = true;
    return;
  }
  if (!child) {
    spawnChild();
    return;
  }
  // Wait for the old process to release the port before binding it again.
  restarting = true;
  const old = child;
  old.once('exit', () => {
    restarting = false;
    child = null;
    if (pendingRestart) {
      pendingRestart = false;
    }
    spawnChild();
  });
  old.kill('SIGTERM');
}

const compiler = webpack(config);
const watching = compiler.watch({ aggregateTimeout: 100, ignored: /node_modules/ }, (err, stats) => {
  if (err) {
    console.error('[dev-serve]', err);
    return;
  }
  console.log(stats.toString({ preset: 'minimal', colors: true }));
  if (stats.hasErrors()) {
    console.error('[dev-serve] build failed; keeping the previous process alive');
    return;
  }
  restart();
});

function shutdown() {
  restarting = true;
  if (child) child.kill('SIGTERM');
  watching.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
