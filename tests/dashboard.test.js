const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRouter } = require('../src/router');
const { createDefaultState } = require('../src/store');
const { createDashboardHandler, buildDashboardHtml, renderStatusText } = require('../src/dashboard');

function createConfig() {
  return {
    version: 1,
    defaultProviderId: 'claude',
    switchThreshold: 0.99,
    dashboard: { host: '127.0.0.1', port: 0, refreshMs: 100 },
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

test('dashboard server exposes the state API and active-provider switch', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-'));
  const config = createConfig();
  const state = createDefaultState(config, cwd);
  state.providerState.claude.usedTokens = 1200;
  state.providerState.claude.health = 'ready';
  state.providerState.claude.statusUsage = {
    totalTokens: 1200,
    source: 'provider-status',
    scope: 'account',
  };
  state.providerState.codex.usedTokens = 2600;
  state.providerState.codex.health = 'ready';
  state.providerState.codex.statusUsage = {
    totalTokens: 2600,
    source: 'codex-local-state',
    scope: 'account',
  };
  state.activeProviderId = 'claude';

  const router = createRouter({
    config,
    state,
    cwd,
    env: createIsolatedEnv(),
    runner: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  const handler = createDashboardHandler(router);

  function invoke(method, url, body) {
    return new Promise((resolve, reject) => {
      const req = new EventEmitter();
      req.method = method;
      req.url = url;
      req.headers = { host: 'localhost' };

      const chunks = [];
      const res = {
        writeHead(statusCode, headers) {
          this.statusCode = statusCode;
          this.headers = headers;
        },
        end(payload = '') {
          chunks.push(Buffer.from(String(payload)));
          resolve({
            statusCode: this.statusCode || 200,
            headers: this.headers || {},
            body: Buffer.concat(chunks).toString('utf8'),
          });
        },
      };

      process.nextTick(() => {
        if (body !== undefined) {
          req.emit('data', Buffer.from(JSON.stringify(body)));
        }
        req.emit('end');
      });

      handler(req, res).catch(reject);
    });
  }

  const html = buildDashboardHtml(router.snapshot());
  assert.match(html, /AI Model Router/);
  assert.match(html, /conic-gradient/);
  assert.match(html, /const PROJECT_CWD =/);
  assert.match(html, /STATE_URL = PROJECT_CWD/);
  assert.match(html, /Refresh<\/button>/);
  assert.match(html, /Global account total/);
  assert.match(html, /Providers/);
  assert.match(html, /Activity/);
  assert.match(html, /inactive/);
  assert.match(html, /Account usage/);
  assert.doesNotMatch(html, /setInterval\(refresh/);

  const stateResponse = await invoke('GET', '/api/state');
  assert.equal(stateResponse.statusCode, 200);
  const snapshot = JSON.parse(stateResponse.body);
  assert.equal(snapshot.activeProviderId, 'claude');
  assert.equal(snapshot.providerViews.length, 2);
  assert.match(renderStatusText(snapshot), /Global summary/);
  assert.match(renderStatusText(snapshot), /Providers/);
  assert.match(renderStatusText(snapshot), /Claude/);

  const switchResponse = await invoke('POST', '/api/active', { providerId: 'codex' });
  assert.equal(switchResponse.statusCode, 200);
  const switchJson = JSON.parse(switchResponse.body);
  assert.equal(switchJson.ok, true);

  const updatedResponse = await invoke('GET', '/api/state');
  const updated = JSON.parse(updatedResponse.body);
  assert.equal(updated.activeProviderId, 'codex');
});
