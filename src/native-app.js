const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { resolveCommand } = require('./runner');
const { ensureRouterStructure, getAppDir } = require('./paths');

function getNativeAppSourcePath() {
  return path.resolve(__dirname, 'native', 'StatusApp.swift');
}

function getNativeAppBinaryPath(env = process.env) {
  return path.join(getAppDir(env), 'model-router-status');
}

function needsRebuild(sourcePath, binaryPath) {
  if (!fs.existsSync(binaryPath)) {
    return true;
  }

  const sourceStat = fs.statSync(sourcePath);
  const binaryStat = fs.statSync(binaryPath);
  return sourceStat.mtimeMs > binaryStat.mtimeMs;
}

function buildNativeStatusApp(env = process.env) {
  ensureRouterStructure(env);
  const sourcePath = getNativeAppSourcePath();
  const binaryPath = getNativeAppBinaryPath(env);
  const moduleCachePath = path.join(getAppDir(env), 'swift-module-cache');
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Native app source not found: ${sourcePath}`);
  }
  fs.mkdirSync(moduleCachePath, { recursive: true });

  const swiftc = resolveCommand('swiftc', env);
  if (!swiftc) {
    throw new Error('swiftc is required to build the native status app');
  }

  if (!needsRebuild(sourcePath, binaryPath)) {
    return binaryPath;
  }

  const result = spawnSync(
    swiftc,
    ['-parse-as-library', '-module-cache-path', moduleCachePath, '-O', '-framework', 'AppKit', '-framework', 'WebKit', '-o', binaryPath, sourcePath],
    {
      env,
      encoding: 'utf8',
    }
  );

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(details || 'Failed to build the native status app');
  }

  fs.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

function launchNativeStatusApp(env = process.env, options = {}) {
  const binaryPath = buildNativeStatusApp(env);
  const args = [];
  if (options.url) {
    args.push('--url', String(options.url));
  }
  if (options.title) {
    args.push('--title', String(options.title));
  }

  const child = spawn(binaryPath, args, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...env,
      AI_MODEL_ROUTER_BIN: path.resolve(__dirname, '..', 'bin', 'model-router.js'),
      ...(options.configPath ? { AI_MODEL_ROUTER_CONFIG: String(options.configPath) } : {}),
      ...(options.url ? { AI_MODEL_ROUTER_DAEMON_URL: String(options.url) } : {}),
    },
  });
  child.unref();
  return {
    binaryPath,
    pid: child.pid,
  };
}

module.exports = {
  buildNativeStatusApp,
  getNativeAppBinaryPath,
  getNativeAppSourcePath,
  launchNativeStatusApp,
};
