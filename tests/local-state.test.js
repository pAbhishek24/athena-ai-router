const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRouter } = require('../src/router');
const { createDefaultState } = require('../src/store');

function createCodexStateDb(dbPath, rows) {
  const statements = [
    'create table threads (cwd text not null, tokens_used integer not null, updated_at integer not null);',
  ];

  for (const row of rows) {
    statements.push(
      `insert into threads (cwd, tokens_used, updated_at) values (${JSON.stringify(row.cwd)}, ${row.tokens_used}, ${row.updated_at});`
    );
  }

  const result = spawnSync('sqlite3', [dbPath, statements.join('\n')], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, records) {
  writeText(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

test('codex local sqlite state sync is reflected in the router snapshot', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-codex-home-'));
  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-sandbox-home-'));
  const dbPath = path.join(homeDir, 'state_1.sqlite');
  const cwd = '/Users/ritikapandey/workspace/athena-ai-router';
  const parentWorkspace = '/Users/ritikapandey/workspace';
  createCodexStateDb(dbPath, [
    { cwd: parentWorkspace, tokens_used: 12345, updated_at: 1781363000 },
    { cwd, tokens_used: 56789, updated_at: 1781363600 },
  ]);

  const config = {
    version: 1,
    defaultProviderId: 'claude',
    switchThreshold: 0.99,
    dashboard: { host: '127.0.0.1', port: 3077 },
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        command: 'claude',
        commandCandidates: ['claude'],
        args: ['-p', '--output-format', 'json'],
        budgetTokens: 200000,
        model: '',
        enabled: true,
      },
      {
        id: 'codex',
        label: 'Codex',
        command: 'codex',
        commandCandidates: ['codex'],
        args: ['exec', '--json', '--skip-git-repo-check'],
        budgetTokens: 200000,
        model: '',
        enabled: true,
      },
    ],
  };

  const state = createDefaultState(config, cwd);
  state.activeProviderId = 'claude';

  const router = createRouter({
    config,
    state,
    cwd,
    env: {
      ...process.env,
      HOME: sandboxHome,
      XDG_STATE_HOME: path.join(sandboxHome, '.state'),
      ATHENA_ROUTER_HOME: path.join(sandboxHome, '.athena-router'),
      CODEX_HOME: homeDir,
    },
  });

  await router.refreshProviderStatus();

  assert.equal(router.state.providerState.codex.usedTokens, 56789);
  assert.equal(router.state.providerState.codex.statusUsage.totalTokens, 69134);
  assert.equal(router.state.providerState.codex.effectiveUsedTokens, 69134);
  assert.equal(router.state.providerState.codex.projectUsedTokens, 56789);
  assert.equal(router.state.activeProviderId, 'codex');
});

test('claude local history sync separates project and account totals', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-claude-home-'));
  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-sandbox-home-'));
  const cwd = '/Users/ritikapandey/workspace/athena-ai-router';
  const workspace = '/Users/ritikapandey/workspace/athena';
  const claudeFile = path.join(homeDir, 'projects', '-Users-ritikapandey-workspace-athena-ai-router', 'thread.jsonl');

  writeJsonl(claudeFile, [
    {
      type: 'assistant',
      timestamp: '2026-06-13T09:00:00.000Z',
      cwd,
      message: {
        role: 'assistant',
        id: 'msg-claude-a',
        usage: {
          input_tokens: 12,
          output_tokens: 18,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-13T09:00:00.000Z',
      cwd,
      message: {
        role: 'assistant',
        id: 'msg-claude-a',
        usage: {
          input_tokens: 12,
          output_tokens: 18,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-13T10:00:00.000Z',
      cwd: workspace,
      message: {
        role: 'assistant',
        id: 'msg-claude-b',
        usage: {
          input_tokens: 7,
          output_tokens: 13,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  ]);

  const config = {
    version: 1,
    defaultProviderId: 'claude',
    switchThreshold: 0.99,
    dashboard: { host: '127.0.0.1', port: 3077 },
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        command: 'node',
        commandCandidates: ['node'],
        args: ['-p', '--output-format', 'json'],
        budgetTokens: 200000,
        model: '',
        enabled: true,
      },
    ],
  };

  const state = createDefaultState(config, cwd);
  const router = createRouter({
    config,
    state,
    cwd,
    env: {
      ...process.env,
      HOME: sandboxHome,
      XDG_STATE_HOME: path.join(sandboxHome, '.state'),
      ATHENA_ROUTER_HOME: path.join(sandboxHome, '.athena-router'),
      CLAUDE_HOME: homeDir,
    },
  });

  await router.refreshProviderStatus();
  const snapshot = router.snapshot();

  assert.equal(router.state.providerState.claude.usedTokens, 30);
  assert.equal(router.state.providerState.claude.statusUsage.totalTokens, 50);
  assert.equal(router.state.providerState.claude.effectiveUsedTokens, 50);
  assert.equal(router.state.providerState.claude.observedLastUsageAt, '2026-06-13T10:00:00.000Z');
  assert.equal(snapshot.totalUsedTokens, 50);
  assert.equal(snapshot.totalProjectUsedTokens, 30);
  assert.equal(snapshot.providerViews[0].projectUsedTokens, 30);
  assert.equal(snapshot.providerViews[0].effectiveUsedTokens, 50);
});

test('gemini history sync is account-wide and preserves the active account label', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-gemini-home-'));
  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-sandbox-home-'));
  const chatFile = path.join(homeDir, 'tmp', 'workspace', 'chats', 'session.jsonl');
  writeJson(path.join(homeDir, 'google_accounts.json'), {
    active: 'gemini.user@example.com',
    old: [],
  });
  writeJsonl(chatFile, [
    {
      id: 'gemini-1',
      timestamp: '2026-06-13T09:00:00.000Z',
      type: 'gemini',
      content: '',
      tokens: {
        input: 5,
        output: 10,
        cached: 1,
        thoughts: 2,
        tool: 0,
        total: 18,
      },
      model: 'gemini-3-flash-preview',
    },
    {
      id: 'gemini-1',
      timestamp: '2026-06-13T09:00:00.000Z',
      type: 'gemini',
      content: '',
      tokens: {
        input: 5,
        output: 10,
        cached: 1,
        thoughts: 2,
        tool: 0,
        total: 18,
      },
      model: 'gemini-3-flash-preview',
    },
    {
      id: 'gemini-2',
      timestamp: '2026-06-13T11:45:00.000Z',
      type: 'gemini',
      content: '',
      tokens: {
        input: 3,
        output: 4,
        cached: 0,
        thoughts: 0,
        tool: 0,
        total: 7,
      },
      model: 'gemini-3-flash-preview',
    },
  ]);

  const config = {
    version: 1,
    defaultProviderId: 'gemini',
    switchThreshold: 0.99,
    dashboard: { host: '127.0.0.1', port: 3077 },
    providers: [
      {
        id: 'gemini',
        label: 'Gemini',
        command: 'node',
        commandCandidates: ['node'],
        args: [],
        budgetTokens: 200000,
        model: '',
        enabled: true,
      },
    ],
  };

  const state = createDefaultState(config, '/Users/ritikapandey/workspace');
  const router = createRouter({
    config,
    state,
    cwd: '/Users/ritikapandey/workspace/athena-ai-router',
    env: {
      ...process.env,
      HOME: sandboxHome,
      XDG_STATE_HOME: path.join(sandboxHome, '.state'),
      ATHENA_ROUTER_HOME: path.join(sandboxHome, '.athena-router'),
      GEMINI_HOME: homeDir,
    },
  });

  await router.refreshProviderStatus();
  const snapshot = router.snapshot();

  assert.equal(router.state.providerState.gemini.accountLabel, 'gemini.user@example.com');
  assert.equal(router.state.providerState.gemini.usedTokens, 0);
  assert.equal(router.state.providerState.gemini.statusUsage.totalTokens, 25);
  assert.equal(router.state.providerState.gemini.effectiveUsedTokens, 25);
  assert.equal(router.state.providerState.gemini.observedLastUsageAt, '2026-06-13T11:45:00.000Z');
  assert.equal(snapshot.totalUsedTokens, 25);
  assert.equal(snapshot.totalProjectUsedTokens, 0);
});

test('local router state rolls up project and account totals for local models', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-home-'));
  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-sandbox-home-'));
  const cwd = '/Users/ritikapandey/workspace/athena-ai-router';
  const config = {
    version: 1,
    defaultProviderId: 'lmstudio',
    switchThreshold: 0.99,
    dashboard: { host: '127.0.0.1', port: 3077 },
    providers: [
      {
        id: 'lmstudio',
        label: 'LM Studio',
        transport: 'http',
        command: '',
        commandCandidates: [],
        args: [],
        budgetTokens: 50000,
        model: 'local-model',
        enabled: true,
        http: {
          baseUrl: 'http://127.0.0.1:1234',
          path: '/v1/chat/completions',
          method: 'POST',
          mode: 'openai-chat',
          headers: {},
          timeoutMs: 120000,
          apiKeyEnv: '',
          systemPrompt: '',
          responsePath: '',
          usagePath: '',
          sessionRefPath: '',
          extraBody: {},
        },
      },
    ],
  };
  const projectOne = createDefaultState(config, cwd);
  projectOne.providerState.lmstudio.usedTokens = 222;
  projectOne.providerState.lmstudio.lastUsageAt = '2026-06-13T09:15:00.000Z';
  projectOne.providerState.lmstudio.health = 'ready';

  const projectTwo = createDefaultState(config, '/Users/ritikapandey/workspace/personal-finance-assistant');
  projectTwo.providerState.lmstudio.usedTokens = 333;
  projectTwo.providerState.lmstudio.lastUsageAt = '2026-06-13T11:45:00.000Z';
  projectTwo.providerState.lmstudio.health = 'ready';

  writeJson(path.join(homeDir, 'projects', 'project-one.json'), projectOne);
  writeJson(path.join(homeDir, 'projects', 'project-two.json'), projectTwo);

  const router = createRouter({
    config,
    state: createDefaultState(config, cwd),
    cwd,
    env: {
      ...process.env,
      HOME: sandboxHome,
      XDG_STATE_HOME: path.join(sandboxHome, '.state'),
      ATHENA_ROUTER_HOME: path.join(sandboxHome, '.athena-router'),
      AI_MODEL_ROUTER_HOME: homeDir,
    },
  });

  await router.refreshProviderStatus();
  const snapshot = router.snapshot();

  assert.equal(router.state.providerState.lmstudio.usedTokens, 222);
  assert.equal(router.state.providerState.lmstudio.projectUsage.totalTokens, 222);
  assert.equal(router.state.providerState.lmstudio.accountUsage.totalTokens, 555);
  assert.equal(router.state.providerState.lmstudio.statusUsage.totalTokens, 555);
  assert.equal(router.state.providerState.lmstudio.effectiveUsedTokens, 555);
  assert.equal(snapshot.totalUsedTokens, 555);
  assert.equal(snapshot.totalProjectUsedTokens, 222);
});
