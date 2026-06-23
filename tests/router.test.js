const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createRouter, buildContextPreview } = require('../src/router');
const { createDefaultState } = require('../src/store');

function createConfig() {
  return {
    version: 1,
    defaultProviderId: 'claude',
    switchThreshold: 0.99,
    dashboard: { host: '127.0.0.1', port: 3077, refreshMs: 2000 },
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        command: 'node',
        args: ['-p', '--output-format', 'json'],
        budgetTokens: 5000,
        model: '',
        enabled: true,
      },
      {
        id: 'codex',
        label: 'Codex',
        command: 'node',
        args: ['exec', '--json', '--skip-git-repo-check'],
        budgetTokens: 10000,
        model: '',
        enabled: true,
      },
    ],
  };
}

function createState(config, cwd) {
  const state = createDefaultState(config, cwd);
  state.providerState.claude.usedTokens = 4950;
  state.providerState.claude.health = 'ready';
  state.providerState.codex.usedTokens = 1000;
  state.providerState.codex.health = 'ready';
  state.activeProviderId = 'claude';
  return state;
}

function createIsolatedEnv() {
  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-sandbox-home-'));
  return {
    ...process.env,
    HOME: sandboxHome,
    XDG_STATE_HOME: path.join(sandboxHome, '.state'),
    ATHENA_ROUTER_HOME: path.join(sandboxHome, '.athena-router'),
    CLAUDE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-claude-home-')),
    CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-codex-home-')),
    GEMINI_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-gemini-home-')),
    AI_MODEL_ROUTER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-state-home-')),
  };
}

test('router switches away from a provider at the threshold without losing context', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-'));
  const config = createConfig();
  const state = createState(config, cwd);
  const calls = [];

  const router = createRouter({
    config,
    state,
    cwd,
    env: createIsolatedEnv(),
    runner: async (command, args) => {
      calls.push({ command, args });
      return {
        code: 0,
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-codex' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex answer' } }),
          JSON.stringify({
            type: 'turn.completed',
            usage: {
              input_tokens: 12,
              cached_input_tokens: 2,
              output_tokens: 8,
              reasoning_output_tokens: 4,
            },
          }),
        ].join('\n'),
        stderr: '',
      };
    },
  });

  const preview = buildContextPreview(state, cwd, 'Build the router');
  assert.match(preview, /Shared summary/);

  const result = await router.send('Build the router');

  assert.equal(result.ok, true);
  assert.equal(result.providerId, 'codex');
  assert.equal(result.switchedFrom, 'claude');
  assert.equal(result.switchedTo, null);
  assert.equal(result.handoffReason, 'threshold');
  assert.equal(result.text, 'codex answer');
  assert.equal(result.usage.totalTokens, 24);
  assert.equal(calls.length, 1);
  assert.equal(router.state.activeProviderId, 'codex');
  assert.ok(router.state.providerState.codex.usedTokens > 10);
});

test('router switches based on account-wide usage when the project ledger is still low', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-'));
  const config = createConfig();
  const state = createState(config, cwd);
  state.providerState.claude.usedTokens = 10;
  state.providerState.claude.projectUsedTokens = 10;
  state.providerState.claude.statusUsage = {
    totalTokens: 4990,
    promptTokens: 3000,
    completionTokens: 1990,
    source: 'provider-status',
    scope: 'account',
  };
  state.providerState.claude.observedUsage = state.providerState.claude.statusUsage;
  state.providerState.claude.effectiveUsedTokens = 4990;
  state.providerState.claude.accountUsedTokens = 4990;
  state.providerState.claude.observedLastUsageAt = '2026-06-13T10:00:00.000Z';
  state.providerState.claude.health = 'ready';
  state.providerState.codex.usedTokens = 0;
  state.providerState.codex.projectUsedTokens = 0;
  state.providerState.codex.health = 'ready';
  state.activeProviderId = 'claude';

  const calls = [];
  const router = createRouter({
    config,
    state,
    cwd,
    env: createIsolatedEnv(),
    runner: async (command, args) => {
      calls.push({ command, args });
      return {
        code: 0,
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-codex' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex answer' } }),
          JSON.stringify({
            type: 'turn.completed',
            usage: {
              input_tokens: 12,
              cached_input_tokens: 2,
              output_tokens: 8,
              reasoning_output_tokens: 4,
            },
          }),
        ].join('\n'),
        stderr: '',
      };
    },
  });

  const result = await router.send('Build the router');

  assert.equal(result.ok, true);
  assert.equal(result.providerId, 'codex');
  assert.equal(result.switchedFrom, 'claude');
  assert.equal(result.handoffReason, 'threshold');
  assert.equal(calls.length, 1);
  assert.equal(router.state.activeProviderId, 'codex');
});

test('router falls back to another provider when the active one fails', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-'));
  const config = createConfig();
  const state = createDefaultState(config, cwd);
  state.providerState.claude.usedTokens = 1200;
  state.providerState.claude.health = 'ready';
  state.providerState.codex.usedTokens = 500;
  state.providerState.codex.health = 'ready';
  state.activeProviderId = 'claude';

  const calls = [];
  const router = createRouter({
    config,
    state,
    cwd,
    env: createIsolatedEnv(),
    runner: async (command, args) => {
      calls.push({ command, args });
      if (calls.length === 1) {
        return {
          code: 1,
          stdout: JSON.stringify({
            type: 'result',
            is_error: true,
            result: 'Not logged in',
          }),
          stderr: '',
        };
      }

      return {
        code: 0,
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-codex' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fallback answer' } }),
          JSON.stringify({
            type: 'turn.completed',
            usage: {
              input_tokens: 7,
              cached_input_tokens: 1,
              output_tokens: 9,
              reasoning_output_tokens: 3,
            },
          }),
        ].join('\n'),
        stderr: '',
      };
    },
  });

  const result = await router.send('Continue the task');

  assert.equal(result.ok, true);
  assert.equal(result.providerId, 'codex');
  assert.equal(result.switchedFrom, 'claude');
  assert.equal(result.handoffReason, 'failure');
  assert.equal(result.text, 'fallback answer');
  assert.equal(calls.length, 2);
  assert.equal(router.state.activeProviderId, 'codex');
});

test('router can hand off from a CLI provider to an HTTP local model', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-'));
  const config = {
    ...createConfig(),
    providers: [
      createConfig().providers[0],
      {
        id: 'lmstudio',
        label: 'LM Studio',
        transport: 'http',
        model: 'local-model',
        budgetTokens: 8000,
        enabled: true,
        http: {
          baseUrl: 'http://127.0.0.1:1234',
          path: '/v1/chat/completions',
          mode: 'openai-chat',
        },
      },
    ],
  };
  const state = createDefaultState(config, cwd);
  state.providerState.claude.usedTokens = 4950;
  state.providerState.claude.health = 'ready';
  state.providerState.lmstudio.usedTokens = 500;
  state.providerState.lmstudio.health = 'ready';
  state.activeProviderId = 'claude';

  const requests = [];
  const router = createRouter({
    config,
    state,
    cwd,
    env: createIsolatedEnv(),
    fetchImpl: async (url, init) => {
      requests.push({
        url,
        init: {
          ...init,
          headers: { ...init.headers },
        },
      });

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            id: 'local-session-1',
            choices: [{ message: { content: 'local model answer' } }],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 14,
            },
          }),
      };
    },
    runner: async () => {
      throw new Error('runner should not be used for HTTP providers');
    },
  });

  const result = await router.send('Continue the project');

  assert.equal(result.ok, true);
  assert.equal(result.providerId, 'lmstudio');
  assert.equal(result.switchedFrom, 'claude');
  assert.equal(result.handoffReason, 'threshold');
  assert.equal(result.text, 'local model answer');
  assert.equal(result.usage.totalTokens, 32);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:1234/v1/chat/completions');
  const requestBody = JSON.parse(requests[0].init.body);
  assert.match(requestBody.messages[0].content, /Target provider: LM Studio/);
  assert.equal(router.state.activeProviderId, 'lmstudio');
});

test('router falls back when Gemini reports an unsupported client', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-'));
  const config = {
    ...createConfig(),
    providers: [
      {
        id: 'gemini',
        label: 'Gemini',
        command: 'node',
        args: ['-p', '--output-format', 'json'],
        budgetTokens: 10000,
        model: '',
        enabled: true,
      },
      createConfig().providers[1],
    ],
  };
  const state = createDefaultState(config, cwd);
  state.providerState.gemini.health = 'ready';
  state.providerState.codex.health = 'ready';
  state.activeProviderId = 'gemini';

  const calls = [];
  const router = createRouter({
    config,
    state,
    cwd,
    env: createIsolatedEnv(),
    runner: async () => {
      calls.push(true);
      if (calls.length === 1) {
        return {
          code: 1,
          stdout: '',
          stderr:
            'IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google.',
        };
      }

      return {
        code: 0,
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-codex' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fallback answer' } }),
        ].join('\n'),
        stderr: '',
      };
    },
  });

  const result = await router.send('Continue the task');

  assert.equal(result.ok, true);
  assert.equal(result.providerId, 'codex');
  assert.equal(result.switchedFrom, 'gemini');
  assert.equal(result.handoffReason, 'failure');
  assert.equal(result.text, 'fallback answer');
  assert.equal(calls.length, 2);
  assert.equal(router.state.activeProviderId, 'codex');
});

test('router uses the built-in command runner when none is provided', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-'));
  const config = {
    version: 1,
    defaultProviderId: 'local',
    switchThreshold: 0.99,
    dashboard: { host: '127.0.0.1', port: 3077, refreshMs: 2000 },
    providers: [
      {
        id: 'local',
        label: 'Local',
        command: 'node',
        args: ['-e', 'process.stdout.write(process.argv.slice(1).join(" "))'],
        budgetTokens: 5000,
        model: '',
        enabled: true,
      },
    ],
  };
  const state = createDefaultState(config, cwd);
  state.providerState.local.health = 'ready';
  state.activeProviderId = 'local';

  const router = createRouter({
    config,
    state,
    cwd,
    env: createIsolatedEnv(),
  });

  const result = await router.send('Inspect the workspace');

  assert.equal(result.ok, true);
  assert.equal(result.providerId, 'local');
  assert.match(result.text, /Current user request:/);
  assert.match(result.text, /Inspect the workspace/);
});

test('router keeps a provider available when its status probe fails generically', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-'));
  const config = {
    version: 1,
    defaultProviderId: 'local',
    switchThreshold: 0.99,
    dashboard: { host: '127.0.0.1', port: 3077, refreshMs: 2000 },
    providers: [
      {
        id: 'local',
        label: 'Local',
        command: 'node',
        args: ['-e', 'process.stdout.write(process.argv.slice(1).join(" "))'],
        budgetTokens: 5000,
        model: '',
        enabled: true,
        status: {
          command: 'node',
          args: ['-e', 'process.stderr.write("browser login required"); process.exit(1);'],
        },
      },
    ],
  };
  const state = createDefaultState(config, cwd);
  state.providerState.local.health = 'unknown';
  state.activeProviderId = 'local';

  const router = createRouter({
    config,
    state,
    cwd,
    env: createIsolatedEnv(),
  });

  await router.refreshProviderStatus();

  assert.equal(router.state.providerState.local.health, 'ready');
  assert.equal(router.state.providerState.local.authState, 'ready');
  assert.match(router.state.providerState.local.statusMessage || '', /browser login required/);
});
