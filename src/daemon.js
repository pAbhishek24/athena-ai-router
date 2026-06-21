const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');
const { loadConfig } = require('./config');
const { createRouter } = require('./router');
const { appendExchange, loadState, saveState, updateProviderUsage } = require('./store');
const { ensureRouterStructure, getDaemonStatePath, getProjectsDir } = require('./paths');
const { runCommand } = require('./runner');
const { buildDashboardHtml, renderStatusText } = require('./dashboard');

const DEFAULT_DAEMON_POLL_MS = 30000;

function getDaemonUrl(config, env = process.env) {
  if (env.AI_MODEL_ROUTER_DAEMON_URL && String(env.AI_MODEL_ROUTER_DAEMON_URL).trim()) {
    return String(env.AI_MODEL_ROUTER_DAEMON_URL).trim();
  }
  const metadata = readJsonSafe(getDaemonStatePath(env));
  if (metadata && typeof metadata.url === 'string' && metadata.url.trim()) {
    return metadata.url.trim();
  }
  const host = config.dashboard?.host || '127.0.0.1';
  const port = Number.isFinite(config.dashboard?.port) ? config.dashboard.port : 3077;
  return `http://${host}:${port}`;
}

function getBinPath() {
  return path.resolve(__dirname, '..', 'bin', 'model-router.js');
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveRequestCwd(requestUrl, body, fallbackCwd = process.cwd()) {
  if (body && typeof body.cwd === 'string' && body.cwd.trim()) {
    return path.resolve(body.cwd.trim());
  }

  const url = new URL(requestUrl || '/', 'http://localhost');
  const queryCwd = url.searchParams.get('cwd');
  if (queryCwd && queryCwd.trim()) {
    return path.resolve(queryCwd.trim());
  }

  return path.resolve(fallbackCwd);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        const text = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function buildProjectRouter(cwd, env, config, options = {}) {
  const { state, statePath } = loadState(config, cwd, env);
  return createRouter({
    config,
    state,
    cwd,
    env,
    runner: options.runner || runCommand,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    statePath,
    persist: true,
  });
}

async function refreshProjectStatus(cwd, env, config, options = {}) {
  const router = await buildProjectRouter(cwd, env, config, options);
  await router.refreshProviderStatus();
  router.save();
  return router.snapshot();
}

async function refreshAllProjectStatuses(env, config, options = {}) {
  ensureRouterStructure(env);
  const projectsDir = getProjectsDir(env);
  if (!fs.existsSync(projectsDir)) {
    return 0;
  }

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  let refreshed = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const statePath = path.join(projectsDir, entry.name);
    const loaded = readJsonSafe(statePath);
    const cwd = loaded && loaded.project && typeof loaded.project.cwd === 'string' ? loaded.project.cwd : null;
    if (!cwd) {
      continue;
    }

    try {
      await refreshProjectStatus(cwd, env, config, options);
      refreshed += 1;
    } catch {
      // Ignore corrupted or inaccessible project states during background polling.
    }
  }

  return refreshed;
}

async function handleShimReport(body, env, config) {
  const cwd = resolveRequestCwd('/api/shim', body, process.cwd());
  const providerId = String(body.providerId || '').trim();
  if (!providerId) {
    return { ok: false, error: 'providerId is required' };
  }

  const { state, statePath } = loadState(config, cwd, env);
  const usage = body.usage && typeof body.usage === 'object' ? body.usage : {};
  const sessionRef = body.sessionRef && typeof body.sessionRef === 'object' ? body.sessionRef : null;
  updateProviderUsage(state, providerId, usage, sessionRef, body.errorMessage || null);

  if (typeof body.promptText === 'string' && body.promptText.trim()) {
    appendExchange(state, {
      at: new Date().toISOString(),
      userText: body.promptText.trim(),
      assistantText: String(body.stdout || body.stderr || '').trim(),
      providerId,
      usage,
    });
  }

  saveState(state, statePath, env);
  return { ok: true, snapshot: createRouter({ config, state, cwd, env, persist: false, statePath }).snapshot() };
}

async function handleRequest(req, res, env, config) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, status: 'running' });
    return;
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const cwd = resolveRequestCwd(req.url || '/', null, process.cwd());
    const snapshot = await refreshProjectStatus(cwd, env, config);
    sendJson(res, 200, snapshot);
    return;
  }

  if (url.pathname === '/api/ask' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const cwd = resolveRequestCwd(req.url || '/', body, process.cwd());
      const prompt = String(body.prompt || '').trim();
      if (!prompt) {
        sendJson(res, 400, { ok: false, error: 'prompt is required' });
        return;
      }
      const router = await buildProjectRouter(cwd, env, config);
      const result = await router.send(prompt);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (url.pathname === '/api/active' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const cwd = resolveRequestCwd(req.url || '/', body, process.cwd());
      const providerId = String(body.providerId || '').trim();
      if (!providerId) {
        sendJson(res, 400, { ok: false, error: 'providerId is required' });
        return;
      }
      const router = await buildProjectRouter(cwd, env, config);
      const ok = router.setActiveProvider(providerId, body.reason || 'manual');
      if (!ok) {
        sendJson(res, 404, { ok: false, error: `Unknown provider ${providerId}` });
        return;
      }
      sendJson(res, 200, { ok: true, activeProviderId: providerId, snapshot: router.snapshot() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (url.pathname === '/api/shim' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const result = await handleShimReport(body, env, config);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  const cwd = resolveRequestCwd(req.url || '/', null, process.cwd());
  const snapshot = await refreshProjectStatus(cwd, env, config);
  const html = buildDashboardHtml(snapshot);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

async function createDaemonServer(env = process.env, options = {}) {
  const { config } = loadConfig(env, { configPath: options.configPath || undefined });
  const host = options.host || config.dashboard.host || '127.0.0.1';
  const port = Number.isFinite(options.port) ? options.port : config.dashboard.port || 3077;
  const pollMs =
    Number.isFinite(options.pollMs) && options.pollMs > 0
      ? options.pollMs
      : Number.isFinite(config.daemon?.pollMs) && config.daemon.pollMs > 0
        ? config.daemon.pollMs
        : DEFAULT_DAEMON_POLL_MS;
  const server = http.createServer((req, res) => handleRequest(req, res, env, config));

  const writeDaemonMetadata = (startedAt) => {
    writeJson(getDaemonStatePath(env), {
      pid: process.pid,
      host,
      port,
      url: `http://${host}:${port}`,
      startedAt,
      configPath: loadConfig(env, { configPath: options.configPath || undefined }).configPath,
      pollMs,
    });
  };

  const startedAt = new Date().toISOString();
  let pollTimer = null;
  let closing = false;

  async function poll() {
    if (closing) {
      return;
    }
    try {
      await refreshAllProjectStatuses(env, config);
    } catch {
      // Keep the daemon alive if a refresh fails.
    }
  }

  return {
    host,
    port,
    pollMs,
    server,
    async listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          writeDaemonMetadata(startedAt);
          pollTimer = setInterval(poll, pollMs);
          poll().catch(() => {});
          const address = server.address();
          const resolvedPort = address && typeof address === 'object' ? address.port : port;
          resolve({
            host,
            port: resolvedPort,
            url: `http://${host}:${resolvedPort}`,
          });
        });
      });
    },
    async close() {
      closing = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      await new Promise((resolve) => server.close(() => resolve()));
      const daemonStatePath = getDaemonStatePath(env);
      if (fs.existsSync(daemonStatePath)) {
        try {
          const metadata = readJsonSafe(daemonStatePath);
          if (metadata && metadata.pid === process.pid) {
            fs.unlinkSync(daemonStatePath);
          }
        } catch {
          // Ignore removal failures.
        }
      }
    },
  };
}

async function isDaemonHealthy(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForDaemon(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDaemonHealthy(baseUrl)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function startDetachedDaemon(env = process.env, options = {}) {
  ensureRouterStructure(env);
  const configPath = options.configPath || env.AI_MODEL_ROUTER_CONFIG || env.ATHENA_ROUTER_CONFIG || undefined;
  const args = ['daemon', 'run'];
  if (configPath) {
    args.push('--config', configPath);
  }
  if (options.host) {
    args.push('--host', options.host);
  }
  if (Number.isFinite(options.port)) {
    args.push('--port', String(options.port));
  }
  const child = spawn(process.execPath, [getBinPath(), ...args], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...env,
      ...(configPath ? { AI_MODEL_ROUTER_CONFIG: configPath } : {}),
    },
  });
  child.unref();
  return child;
}

async function ensureDaemonRunning(env = process.env, options = {}) {
  const { config } = loadConfig(env, { configPath: options.configPath || undefined });
  const baseUrl = getDaemonUrl(config, env);
  if (await isDaemonHealthy(baseUrl)) {
    return { started: false, url: baseUrl };
  }

  startDetachedDaemon(env, { configPath: options.configPath || undefined, host: config.dashboard.host, port: config.dashboard.port });
  const ready = await waitForDaemon(baseUrl, options.timeoutMs || 15000);
  return { started: true, url: baseUrl, ready };
}

function createDaemonClient({ cwd, env = process.env, config, baseUrl } = {}) {
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const effectiveConfig = config || loadConfig(env, {}).config;
  const daemonUrl = baseUrl || getDaemonUrl(effectiveConfig, env);
  const state = {
    cwd: resolvedCwd,
    project: null,
    providerState: {},
  };
  let latestSnapshot = null;

  function cloneProviderStateFromSnapshot(snapshot) {
    return (snapshot.providerViews || []).reduce((acc, provider) => {
      acc[provider.id] = {
        limitTokens: provider.limitTokens,
        usedTokens: provider.usedTokens,
        projectUsedTokens: provider.projectUsedTokens || provider.usedTokens || 0,
        effectiveUsedTokens: provider.effectiveUsedTokens || provider.accountUsedTokens || provider.usedTokens || 0,
        accountUsedTokens: provider.accountUsedTokens || provider.effectiveUsedTokens || provider.usedTokens || 0,
        health: provider.health,
        authState: provider.authState,
        accountLabel: provider.accountLabel,
        statusMessage: provider.statusMessage,
        statusUsage: provider.statusUsage,
        observedUsage: provider.observedUsage,
        projectUsage: provider.projectUsage,
        accountUsage: provider.accountUsage,
        lastSessionRef: provider.lastSessionRef,
        lastStatusAt: provider.lastStatusAt,
        lastUsageAt: provider.lastUsageAt,
        observedLastUsageAt: provider.observedLastUsageAt,
      };
      return acc;
    }, {});
  }

  function getUsageTotal(usage) {
    return usage && Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0;
  }

  function buildCachedSnapshot() {
    const providerViews = effectiveConfig.providers.map((provider) => {
      const stats = state.providerState[provider.id] || {};
      const limit = Number.isFinite(stats.limitTokens) && stats.limitTokens > 0 ? stats.limitTokens : provider.budgetTokens || 0;
      const projectUsed = Number.isFinite(stats.usedTokens) ? stats.usedTokens : Number.isFinite(stats.projectUsedTokens) ? stats.projectUsedTokens : 0;
      const observedUsage = stats.observedUsage || stats.accountUsage || stats.statusUsage || null;
      const effectiveUsed = Number.isFinite(stats.effectiveUsedTokens) && stats.effectiveUsedTokens > 0
        ? stats.effectiveUsedTokens
        : Number.isFinite(stats.accountUsedTokens) && stats.accountUsedTokens > 0
          ? stats.accountUsedTokens
          : getUsageTotal(observedUsage) || projectUsed;
      const remaining = Math.max(0, limit - effectiveUsed);
      const projectRemaining = Math.max(0, limit - projectUsed);
      const ratio = limit > 0 ? effectiveUsed / limit : 0;
      const projectRatio = limit > 0 ? projectUsed / limit : 0;
      const stateLabel = provider.enabled === false ? 'disabled' : state.activeProviderId === provider.id ? 'active' : 'inactive';
      return {
        id: provider.id,
        label: provider.label,
        command: provider.command,
        target: provider.command || provider.commandCandidates?.[0] || '',
        transport: provider.transport || 'command',
        model: provider.model || '',
        enabled: provider.enabled !== false,
        stateLabel,
        health: stats.health || 'unknown',
        authState: stats.authState || 'unknown',
        accountLabel: stats.accountLabel || null,
        statusMessage: stats.statusMessage || null,
        statusUsage: stats.statusUsage || stats.accountUsage || null,
        observedUsage: stats.observedUsage || stats.accountUsage || stats.statusUsage || null,
        projectUsage: stats.projectUsage || null,
        accountUsage: stats.accountUsage || stats.observedUsage || stats.statusUsage || null,
        usedTokens: projectUsed,
        projectUsedTokens: projectUsed,
        effectiveUsedTokens: effectiveUsed,
        accountUsedTokens: effectiveUsed,
        limitTokens: limit,
        remainingTokens: remaining,
        projectRemainingTokens: projectRemaining,
        ratio,
        ratioPercent: Number.isFinite(ratio) ? ratio * 100 : 0,
        projectRatio,
        projectRatioPercent: Number.isFinite(projectRatio) ? projectRatio * 100 : 0,
        totalTurns: stats.totalTurns || 0,
        lastError: stats.lastError || null,
        lastSessionRef: stats.lastSessionRef || null,
        lastStatusAt: stats.lastStatusAt || null,
        lastUsageAt: stats.lastUsageAt || null,
        observedLastUsageAt: stats.observedLastUsageAt || null,
        isActive: state.activeProviderId === provider.id,
      };
    });

    const activeProvider = providerViews.find((provider) => provider.isActive) || providerViews[0] || null;
    const nextProvider = providerViews.find((provider) => provider.enabled !== false && (!activeProvider || provider.id !== activeProvider.id)) || null;
    const totalUsedTokens = providerViews.reduce((sum, provider) => sum + provider.effectiveUsedTokens, 0);
    const totalProjectUsedTokens = providerViews.reduce((sum, provider) => sum + provider.usedTokens, 0);
    const totalLimitTokens = providerViews.reduce((sum, provider) => sum + provider.limitTokens, 0);

    return {
      cwd: resolvedCwd,
      project: state.project,
      activeProviderId: state.activeProviderId,
      activeProvider,
      nextProvider: nextProvider
        ? {
            id: nextProvider.id,
            label: nextProvider.label,
            usedTokens: nextProvider.usedTokens,
            effectiveUsedTokens: nextProvider.effectiveUsedTokens,
            limitTokens: nextProvider.limitTokens,
          }
        : null,
      threshold: effectiveConfig.switchThreshold || 0.99,
      providerViews,
      summary: '',
      recentExchanges: [],
      handoffs: [],
      workspace: `cwd: ${resolvedCwd}`,
      dashboard: effectiveConfig.dashboard || {},
      totalUsedTokens,
      totalProjectUsedTokens,
      totalLimitTokens,
    };
  }

  function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      return latestSnapshot || buildCachedSnapshot();
    }

    state.providerState = cloneProviderStateFromSnapshot(snapshot);
    state.project = snapshot.project || state.project;
    state.activeProviderId = snapshot.activeProviderId || state.activeProviderId;
    latestSnapshot = snapshot;
    return snapshot;
  }

  async function requestJson(url, init = {}) {
    const response = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) {
      const message = payload && typeof payload === 'object' ? payload.error || payload.message || `HTTP ${response.status}` : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }

  return {
    config: effectiveConfig,
    env,
    cwd: resolvedCwd,
    state,
    snapshot() {
      return latestSnapshot || buildCachedSnapshot();
    },
    async refreshProviderStatus() {
      const snapshot = await requestJson(`${daemonUrl}/api/state?cwd=${encodeURIComponent(resolvedCwd)}`);
      return applySnapshot(snapshot);
    },
    async send(prompt) {
      const result = await requestJson(`${daemonUrl}/api/ask`, {
        method: 'POST',
        body: JSON.stringify({ cwd: resolvedCwd, prompt }),
      });
      if (result && result.snapshotAfterTurn) {
        applySnapshot(result.snapshotAfterTurn);
      }
      return result;
    },
    async setActiveProvider(providerId, reason = 'manual') {
      const result = await requestJson(`${daemonUrl}/api/active`, {
        method: 'POST',
        body: JSON.stringify({ cwd: resolvedCwd, providerId, reason }),
      });
      if (result && result.snapshot) {
        applySnapshot(result.snapshot);
      }
      return !!(result && result.ok);
    },
    async reportShim(payload) {
      return requestJson(`${daemonUrl}/api/shim`, {
        method: 'POST',
        body: JSON.stringify({ cwd: resolvedCwd, ...payload }),
      });
    },
    daemonUrl,
  };
}

function readDaemonMetadata(env = process.env) {
  return readJsonSafe(getDaemonStatePath(env));
}

function stopDaemon(env = process.env) {
  const metadata = readDaemonMetadata(env);
  if (!metadata || !metadata.pid) {
    return { ok: false, error: 'Daemon metadata not found' };
  }

  try {
    process.kill(metadata.pid, 'SIGTERM');
    return { ok: true, pid: metadata.pid };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

module.exports = {
  buildProjectRouter,
  createDaemonClient,
  createDaemonServer,
  ensureDaemonRunning,
  getDaemonUrl,
  handleRequest,
  isDaemonHealthy,
  refreshAllProjectStatuses,
  refreshProjectStatus,
  readDaemonMetadata,
  startDetachedDaemon,
  stopDaemon,
  waitForDaemon,
};
