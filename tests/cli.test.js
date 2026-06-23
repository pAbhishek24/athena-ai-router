const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime, createStatusRuntime, handleChatInput } = require('../src/cli');

test('status falls back to local state when the daemon is absent', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-cwd-'));
  const configPath = path.join(homeDir, 'config.json');
  const originalHome = process.env.AI_MODEL_ROUTER_HOME;
  const originalConfig = process.env.AI_MODEL_ROUTER_CONFIG;

  const config = {
    version: 1,
    defaultProviderId: 'offline',
    switchThreshold: 0.99,
    dashboard: { host: '127.0.0.1', port: 3077 },
    providers: [
      {
        id: 'offline',
        label: 'Offline',
        enabled: false,
        transport: 'http',
        http: { baseUrl: 'http://127.0.0.1:9' },
      },
    ],
  };

  try {
    process.env.AI_MODEL_ROUTER_HOME = homeDir;
    process.env.AI_MODEL_ROUTER_CONFIG = configPath;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const runtime = await createStatusRuntime(['status', '--cwd', cwd, '--config', configPath]);
    const snapshot = runtime.router.snapshot();

    assert.equal(runtime.daemonInfo.ready, false);
    assert.equal(snapshot.cwd, path.resolve(cwd));
    assert.equal(snapshot.providerViews.length, 1);
    assert.equal(snapshot.providerViews[0].health, 'disabled');
  } finally {
    if (originalHome === undefined) {
      delete process.env.AI_MODEL_ROUTER_HOME;
    } else {
      process.env.AI_MODEL_ROUTER_HOME = originalHome;
    }

    if (originalConfig === undefined) {
      delete process.env.AI_MODEL_ROUTER_CONFIG;
    } else {
      process.env.AI_MODEL_ROUTER_CONFIG = originalConfig;
    }
  }
});

test('interactive runtime falls back to the local router when the daemon is unavailable', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-cwd-'));
  const configPath = path.join(homeDir, 'config.json');
  const originalHome = process.env.AI_MODEL_ROUTER_HOME;
  const originalConfig = process.env.AI_MODEL_ROUTER_CONFIG;

  const config = {
    version: 1,
    defaultProviderId: 'offline',
    switchThreshold: 0.99,
    dashboard: { host: '127.0.0.1', port: 3077 },
    providers: [
      {
        id: 'offline',
        label: 'Offline',
        enabled: false,
        transport: 'http',
        http: { baseUrl: 'http://127.0.0.1:9' },
      },
    ],
  };

  try {
    process.env.AI_MODEL_ROUTER_HOME = homeDir;
    process.env.AI_MODEL_ROUTER_CONFIG = configPath;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const runtime = await createRuntime(['chat', '--cwd', cwd, '--config', configPath], {
      allowLocalFallback: true,
      ensureDaemonRunning: async () => ({ started: false, ready: false, url: 'http://127.0.0.1:3077' }),
    });

    assert.equal(runtime.runtimeMode, 'local');
    assert.equal(runtime.daemonInfo.ready, false);
    assert.equal(runtime.router.snapshot().cwd, path.resolve(cwd));
  } finally {
    if (originalHome === undefined) {
      delete process.env.AI_MODEL_ROUTER_HOME;
    } else {
      process.env.AI_MODEL_ROUTER_HOME = originalHome;
    }

    if (originalConfig === undefined) {
      delete process.env.AI_MODEL_ROUTER_CONFIG;
    } else {
      process.env.AI_MODEL_ROUTER_CONFIG = originalConfig;
    }
  }
});

test('chat routes a plain prompt through the agent task flow', async () => {
  const calls = [];
  const writes = [];
  const router = {
    refreshProviderStatus: async () => {},
    snapshot: () => ({ cwd: '/tmp/project', providerViews: [] }),
    setActiveProvider: () => true,
  };

  const result = await handleChatInput(router, 'inspect the project and create a file', {
    runTask: async (_router, _parsed, commandArgs) => {
      calls.push(commandArgs);
      return { ok: true };
    },
    runAsk: async () => {
      throw new Error('ask should not be used for plain prompts');
    },
    stdout: {
      write(value) {
        writes.push(String(value));
      },
    },
  });

  assert.equal(result.exit, false);
  assert.deepEqual(calls, [['inspect the project and create a file']]);
  assert.equal(writes.length, 0);
});
