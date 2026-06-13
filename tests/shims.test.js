const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installShims, runShimExec } = require('../src/shims');

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
}

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
        shimName: 'claude',
        command: 'claude',
        args: ['-p', '--output-format', 'json'],
        budgetTokens: 5000,
        enabled: true,
      },
      {
        id: 'ollama',
        label: 'Ollama',
        transport: 'http',
        enabled: false,
        model: 'llama3.1',
        budgetTokens: 5000,
        http: {
          baseUrl: 'http://127.0.0.1:11434',
          path: '/api/chat',
          mode: 'ollama-chat',
        },
      },
    ],
  };
}

test('installShims writes wrappers and a PATH helper', () => {
  const routerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-home-'));
  const binDir = path.join(routerHome, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');

  const env = {
    ...process.env,
    AI_MODEL_ROUTER_HOME: routerHome,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
  };

  const result = installShims(createConfig(), env);

  const shimPath = path.join(routerHome, 'shims', 'claude');
  assert.equal(fs.existsSync(shimPath), true);
  assert.match(fs.readFileSync(shimPath, 'utf8'), /shims exec 'claude'/);
  assert.equal(fs.existsSync(path.join(routerHome, 'shims', 'env.sh')), true);
  assert.equal(fs.existsSync(path.join(routerHome, 'shims', 'manifest.json')), true);
  assert.equal(result.shims.filter((shim) => shim.status === 'installed').length, 1);
});

test('runShimExec reports usage back to the daemon', async () => {
  const routerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-home-'));
  const binDir = path.join(routerHome, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const configPath = path.join(routerHome, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(createConfig(), null, 2)}\n`);

  const realCommand = path.join(binDir, 'claude-real');
  writeExecutable(
    realCommand,
    [
      '#!/bin/sh',
      'printf \'%s\\n\' \'{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"abc","usage":{"input_tokens":4,"output_tokens":6}}\'',
      '',
    ].join('\n')
  );

  const reports = [];
  const originalFetch = global.fetch;

  const env = {
    ...process.env,
    AI_MODEL_ROUTER_HOME: routerHome,
    AI_MODEL_ROUTER_DAEMON_URL: 'http://daemon.local',
  };

  const stdoutChunks = [];
  const stderrChunks = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  global.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith('/api/health')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '{"ok":true}\n',
      };
    }

    if (target.endsWith('/api/shim')) {
      reports.push(JSON.parse(String(init.body || '{}')));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '{"ok":true}\n',
      };
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  process.stdout.write = (chunk, encoding, callback) => {
    stdoutChunks.push(String(chunk));
    if (typeof callback === 'function') {
      callback();
    }
    return true;
  };
  process.stderr.write = (chunk, encoding, callback) => {
    stderrChunks.push(String(chunk));
    if (typeof callback === 'function') {
      callback();
    }
    return true;
  };

  try {
    await runShimExec(['claude', realCommand], env, { cwd: routerHome });
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    global.fetch = originalFetch;
  }

  assert.equal(reports.length, 1);
  assert.equal(reports[0].providerId, 'claude');
  assert.equal(reports[0].sessionRef.sessionId, 'abc');
  assert.equal(reports[0].usage.totalTokens, 10);
  assert.match(stdoutChunks.join(''), /done/);
  assert.equal(stderrChunks.join(''), '');
});
