const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildHttpRequestBody,
  buildInvocation,
  executeHttpProvider,
  parseClaudeOutput,
  parseCodexOutput,
  probeProviderStatus,
  resolveProviderCommand,
} = require('../src/providers');

test('buildInvocation builds a Claude session command', () => {
  const invocation = buildInvocation(
    {
      id: 'claude',
      command: 'claude',
      args: ['-p', '--output-format', 'json'],
      model: 'sonnet',
    },
    {
      prompt: 'Hello world',
      sessionRef: { sessionId: 'session-123' },
    }
  );

  assert.equal(invocation.command, 'claude');
  assert.deepEqual(invocation.args, ['--model', 'sonnet', '--session-id', 'session-123', '-p', '--output-format', 'json', 'Hello world']);
});

test('buildInvocation builds a Codex resume command', () => {
  const invocation = buildInvocation(
    {
      id: 'codex',
      command: 'codex',
      args: ['exec', '--json', '--skip-git-repo-check'],
      model: 'o3',
    },
    {
      prompt: 'Continue the work',
      sessionRef: { threadId: 'thread-456' },
    }
  );

  assert.equal(invocation.command, 'codex');
  assert.deepEqual(invocation.args, ['--model', 'o3', 'exec', 'resume', '--json', '--skip-git-repo-check', 'thread-456', 'Continue the work']);
});

test('resolveProviderCommand falls back across Gemini candidate names', () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-bin-'));
  const gemniPath = path.join(binDir, 'gemni');
  fs.writeFileSync(gemniPath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(gemniPath, 0o755);

  const resolved = resolveProviderCommand(
    {
      id: 'gemini',
      commandCandidates: ['gemini', 'gemni'],
    },
    { PATH: binDir }
  );

  assert.equal(resolved, gemniPath);
});

test('buildHttpRequestBody builds an Ollama-compatible payload', () => {
  const body = buildHttpRequestBody(
    {
      id: 'ollama',
      model: 'llama3.1',
      temperature: 0.2,
      maxTokens: 128,
      topP: 0.9,
      http: {
        mode: 'ollama-chat',
        systemPrompt: 'Be concise',
        extraBody: {
          keep_alive: '10m',
        },
      },
    },
    'Write a haiku'
  );

  assert.deepEqual(body, {
    model: 'llama3.1',
    messages: [
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'Write a haiku' },
    ],
    stream: false,
    options: {
      temperature: 0.2,
      top_p: 0.9,
      num_predict: 128,
    },
    keep_alive: '10m',
  });
});

test('parseClaudeOutput normalizes usage and session id', () => {
  const payload = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done',
    session_id: 'abc-123',
    usage: {
      input_tokens: 100,
      output_tokens: 25,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
    },
  };

  const parsed = parseClaudeOutput(JSON.stringify(payload), '', 0);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, 'Done');
  assert.deepEqual(parsed.sessionRef, { sessionId: 'abc-123' });
  assert.equal(parsed.usage.promptTokens, 100);
  assert.equal(parsed.usage.completionTokens, 25);
  assert.equal(parsed.usage.cacheCreationTokens, 10);
  assert.equal(parsed.usage.cacheReadTokens, 5);
  assert.equal(parsed.usage.totalTokens, 135);
});

test('parseCodexOutput normalizes JSONL events and usage', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-789' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'All set.' } }),
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 90,
        cached_input_tokens: 12,
        output_tokens: 15,
        reasoning_output_tokens: 6,
      },
    }),
  ].join('\n');

  const parsed = parseCodexOutput(stdout, '', 0);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, 'All set.');
  assert.deepEqual(parsed.sessionRef, { threadId: 'thread-789' });
  assert.equal(parsed.usage.promptTokens, 90);
  assert.equal(parsed.usage.cachedInputTokens, 12);
  assert.equal(parsed.usage.completionTokens, 15);
  assert.equal(parsed.usage.reasoningTokens, 6);
  assert.equal(parsed.usage.totalTokens, 111);
});

test('executeHttpProvider sends an OpenAI-compatible request and parses the response', async () => {
  const requests = [];
  const provider = {
    id: 'lmstudio',
    label: 'LM Studio',
    transport: 'http',
    model: 'local-model',
    http: {
      baseUrl: 'http://127.0.0.1:1234',
      path: '/v1/chat/completions',
      mode: 'openai-chat',
      systemPrompt: 'You are terse.',
    },
  };

  const result = await executeHttpProvider(provider, {
    prompt: 'Explain the plan',
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
            id: 'chatcmpl-1',
            choices: [{ message: { content: 'local reply' } }],
            usage: {
              prompt_tokens: 6,
              completion_tokens: 4,
            },
          }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'local reply');
  assert.deepEqual(result.sessionRef, { sessionId: 'chatcmpl-1' });
  assert.equal(result.usage.promptTokens, 6);
  assert.equal(result.usage.completionTokens, 4);
  assert.equal(result.usage.totalTokens, 10);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers['content-type'], 'application/json');
  const requestBody = JSON.parse(requests[0].init.body);
  assert.equal(requestBody.model, 'local-model');
  assert.deepEqual(requestBody.messages, [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'Explain the plan' },
  ]);
});

test('probeProviderStatus reads structured auth and account metadata', async () => {
  const result = await probeProviderStatus(
    {
      id: 'claude',
      command: 'node',
      status: {
        command: 'node',
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({ authState: "ready", account: { email: "user@example.com" }, usage: { prompt_tokens: 8, completion_tokens: 4 } }))',
        ],
      },
    },
    {
      cwd: process.cwd(),
    }
  );

  assert.equal(result.health, 'ready');
  assert.equal(result.authState, 'ready');
  assert.equal(result.accountLabel, 'user@example.com');
  assert.equal(result.usage.totalTokens, 12);
});
