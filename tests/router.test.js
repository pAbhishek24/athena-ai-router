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

test('router switches away from a provider at the threshold without losing context', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-'));
  const config = createConfig();
  const state = createState(config, cwd);
  const calls = [];

  const router = createRouter({
    config,
    state,
    cwd,
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
  });

  const result = await router.send('Inspect the workspace');

  assert.equal(result.ok, true);
  assert.equal(result.providerId, 'local');
  assert.match(result.text, /Current user request:/);
  assert.match(result.text, /Inspect the workspace/);
});
