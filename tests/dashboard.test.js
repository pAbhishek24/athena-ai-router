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

test('dashboard server exposes the state API and active-provider switch', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-router-'));
  const config = createConfig();
  const state = createDefaultState(config, cwd);
  state.providerState.claude.usedTokens = 1200;
  state.providerState.claude.health = 'ready';
  state.providerState.codex.usedTokens = 2600;
  state.providerState.codex.health = 'ready';
  state.activeProviderId = 'claude';

  const router = createRouter({ config, state, cwd, runner: async () => ({ code: 0, stdout: '', stderr: '' }) });
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
  assert.match(html, /Athena AI Router/);
  assert.match(html, /conic-gradient/);

  const stateResponse = await invoke('GET', '/api/state');
  assert.equal(stateResponse.statusCode, 200);
  const snapshot = JSON.parse(stateResponse.body);
  assert.equal(snapshot.activeProviderId, 'claude');
  assert.equal(snapshot.providerViews.length, 2);
  assert.match(renderStatusText(snapshot), /Claude/);

  const switchResponse = await invoke('POST', '/api/active', { providerId: 'codex' });
  assert.equal(switchResponse.statusCode, 200);
  const switchJson = JSON.parse(switchResponse.body);
  assert.equal(switchJson.ok, true);

  const updatedResponse = await invoke('GET', '/api/state');
  const updated = JSON.parse(updatedResponse.body);
  assert.equal(updated.activeProviderId, 'codex');
});
