const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAgentResponse, runWorkspaceTask } = require('../src/agent');

test('parseAgentResponse accepts fenced json', () => {
  const parsed = parseAgentResponse([
    '```json',
    '{"done":true,"summary":"ok","reply":"Finished","actions":[]}',
    '```',
  ].join('\n'));

  assert.deepEqual(parsed, {
    done: true,
    summary: 'ok',
    reply: 'Finished',
    actions: [],
  });
});

test('runWorkspaceTask can write files through agent actions', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-router-agent-'));
  const prompts = [];
  const responses = [
    JSON.stringify({
      done: false,
      summary: 'create the file',
      reply: 'Creating the file now.',
      actions: [
        {
          type: 'write_file',
          path: 'hello.txt',
          content: 'hello from agent',
        },
      ],
    }),
    JSON.stringify({
      done: true,
      summary: 'finished',
      reply: 'Task complete.',
      actions: [],
    }),
  ];

  const router = {
    env: process.env,
    snapshot() {
      return {
        cwd,
        workspace: `cwd: ${cwd}`,
        summary: '',
        recentExchanges: [],
      };
    },
    async send(prompt) {
      prompts.push(prompt);
      return {
        ok: true,
        providerId: 'claude',
        text: responses.shift(),
        switchedFrom: null,
        switchedTo: null,
      };
    },
  };

  const result = await runWorkspaceTask(router, 'Create a hello file');

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8'), 'hello from agent');
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Act like a CLI IDE assistant/);
  assert.match(prompts[0], /Create a hello file/);
  assert.match(prompts[1], /Tool results:/);
  assert.match(prompts[1], /hello\.txt/);
});
