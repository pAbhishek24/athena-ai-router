const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { createDaemonClient, ensureDaemonRunning } = require('./daemon');
const { parseProviderOutput, resolveProviderCommand } = require('./providers');
const { runCommand } = require('./runner');
const { ensureRouterStructure, getShimsDir } = require('./paths');

function getShimManifestPath(env = process.env) {
  return path.join(getShimsDir(env), 'manifest.json');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return '';
  }

  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    let timer = null;
    const onData = (chunk) => {
      buffer += chunk;
    };
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      process.stdin.pause();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const onEnd = () => finish(buffer);
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    timer = setTimeout(() => finish(buffer), 25);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}

function buildShimScript({ routerCommand = 'model-router', providerId, realCommand }) {
  return [
    '#!/bin/sh',
    'set -eu',
    `exec ${shellQuote(routerCommand)} shims exec ${shellQuote(providerId)} ${shellQuote(realCommand)} "$@"`,
    '',
  ].join('\n');
}

function getShimName(provider) {
  return String(provider.shimName || path.basename(provider.command || provider.commandCandidates?.[0] || provider.id)).trim() || provider.id;
}

function getConfiguredProviders(config) {
  return Array.isArray(config.providers) ? config.providers.filter((provider) => provider && provider.enabled !== false) : [];
}

function resolveRealProviderCommand(provider, env = process.env) {
  const shimsDir = getShimsDir(env);
  const pathEntries = String(env.PATH || '')
    .split(path.delimiter)
    .filter((entry) => entry && path.resolve(entry) !== path.resolve(shimsDir));
  return resolveProviderCommand(provider, {
    ...env,
    PATH: pathEntries.join(path.delimiter),
  });
}

function installShims(config, env = process.env, options = {}) {
  ensureRouterStructure(env);
  const shimsDir = getShimsDir(env);
  const routerCommand = options.routerCommand || 'model-router';
  const manifest = {
    createdAt: new Date().toISOString(),
    shims: [],
  };

  for (const provider of getConfiguredProviders(config)) {
    if (provider.transport && String(provider.transport).toLowerCase() === 'http') {
      continue;
    }

    const realCommand = resolveRealProviderCommand(provider, env);
    const shimName = getShimName(provider);
    const filePath = path.join(shimsDir, shimName);

    if (!realCommand) {
      manifest.shims.push({
        providerId: provider.id,
        shimName,
        filePath,
        status: 'missing',
      });
      continue;
    }

    fs.writeFileSync(filePath, buildShimScript({ routerCommand, providerId: provider.id, realCommand }));
    fs.chmodSync(filePath, 0o755);
    manifest.shims.push({
      providerId: provider.id,
      shimName,
      filePath,
      realCommand,
      status: 'installed',
    });
  }

  const envFile = path.join(shimsDir, 'env.sh');
  fs.writeFileSync(envFile, `export PATH=${shellQuote(shimsDir)}:$PATH\n`);
  fs.chmodSync(envFile, 0o644);

  fs.writeFileSync(getShimManifestPath(env), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    ...manifest,
    shimsDir,
    envFile,
  };
}

function loadShimManifest(env = process.env) {
  const manifestPath = getShimManifestPath(env);
  return {
    manifestPath,
    manifest: readJsonSafe(manifestPath),
  };
}

function removeShims(env = process.env) {
  const shimsDir = getShimsDir(env);
  const { manifest } = loadShimManifest(env);
  const removed = [];

  if (manifest && Array.isArray(manifest.shims)) {
    for (const shim of manifest.shims) {
      if (!shim || !shim.filePath) {
        continue;
      }
      if (fs.existsSync(shim.filePath)) {
        fs.unlinkSync(shim.filePath);
        removed.push(shim.filePath);
      }
    }
  } else if (fs.existsSync(shimsDir)) {
    for (const entry of fs.readdirSync(shimsDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      const filePath = path.join(shimsDir, entry.name);
      if (entry.name === 'manifest.json' || entry.name === 'env.sh' || entry.name.startsWith('.')) {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          removed.push(filePath);
        }
        continue;
      }
      fs.unlinkSync(filePath);
      removed.push(filePath);
    }
  }

  const manifestPath = getShimManifestPath(env);
  if (fs.existsSync(manifestPath)) {
    fs.unlinkSync(manifestPath);
    removed.push(manifestPath);
  }

  const envFile = path.join(shimsDir, 'env.sh');
  if (fs.existsSync(envFile)) {
    fs.unlinkSync(envFile);
    removed.push(envFile);
  }

  return { ok: true, removed };
}

function summarizeShims(env = process.env) {
  const { manifestPath, manifest } = loadShimManifest(env);
  const shimsDir = getShimsDir(env);
  const entries = Array.isArray(manifest?.shims) ? manifest.shims.map((shim) => ({
    ...shim,
    installed: !!(shim && shim.filePath && fs.existsSync(shim.filePath)),
  })) : [];

  return {
    ok: true,
    shimsDir,
    manifestPath,
    envFile: path.join(shimsDir, 'env.sh'),
    exists: !!manifest,
    entries,
    pathHint: `source ${path.join(shimsDir, 'env.sh')}`,
  };
}

async function runShimExec(argv, env = process.env, options = {}) {
  const [providerId, realCommand, ...commandArgs] = Array.isArray(argv) ? argv : [];
  if (!providerId || !realCommand) {
    throw new Error('Usage: model-router shims exec <providerId> <realCommand> [args...]');
  }

  const configBundle = loadConfig(env, { configPath: options.configPath || undefined });
  const provider = configBundle.config.providers.find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const cwd = path.resolve(options.cwd || process.cwd());
  const stdinInput = await readStdinIfPiped();
  const rawResult = await runCommand(realCommand, commandArgs, {
    cwd,
    env,
    input: stdinInput || undefined,
  });

  if (rawResult.stdout) {
    process.stdout.write(rawResult.stdout);
  }
  if (rawResult.stderr) {
    process.stderr.write(rawResult.stderr);
  }

  const parsed = parseProviderOutput(provider, {
    stdout: rawResult.stdout,
    stderr: rawResult.stderr,
    exitCode: rawResult.code,
    promptText: stdinInput || '',
  });

  try {
    const daemonInfo = await ensureDaemonRunning(env, { configPath: configBundle.configPath, timeoutMs: options.timeoutMs || 15000 });
    const client = createDaemonClient({ cwd, env, config: configBundle.config, baseUrl: daemonInfo.url });
    await client.reportShim({
      providerId,
      usage: parsed.usage || null,
      sessionRef: parsed.sessionRef || null,
      stdout: rawResult.stdout || '',
      stderr: rawResult.stderr || '',
      errorMessage: parsed.errorMessage || (rawResult.code !== 0 ? `command exited with code ${rawResult.code}` : null),
      promptText: stdinInput && stdinInput.trim() ? stdinInput.trim() : null,
    });
  } catch {
    // Usage reporting is best-effort so the wrapper still behaves like the underlying CLI.
  }

  if (!parsed.ok && rawResult.code === 0) {
    process.exitCode = 1;
  } else if (rawResult.code !== 0) {
    process.exitCode = rawResult.code;
  }

  return {
    ...parsed,
    raw: rawResult,
  };
}

module.exports = {
  buildShimScript,
  getShimManifestPath,
  getShimName,
  installShims,
  loadShimManifest,
  removeShims,
  runShimExec,
  summarizeShims,
};
