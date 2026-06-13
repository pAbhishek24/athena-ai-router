const fs = require('fs');
const path = require('path');
const { commandExists, runCommand } = require('./runner');

const MAX_ACTIONS_PER_TURN = 8;
const MAX_PROMPT_TRACE_CHARS = 1600;
const MAX_FILE_PREVIEW_CHARS = 4000;
const MAX_SHELL_OUTPUT_CHARS = 5000;

function truncate(text, maxChars) {
  const normalized = String(text || '');
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function stripCodeFences(text) {
  const trimmed = String(text || '').trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function parseAgentResponse(text) {
  const stripped = stripCodeFences(text);
  if (!stripped) {
    return null;
  }

  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

function resolveWorkspacePath(cwd, targetPath) {
  const raw = String(targetPath || '').trim();
  if (!raw) {
    throw new Error('path is required');
  }

  const resolved = path.resolve(cwd, raw);
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${targetPath}`);
  }

  return resolved;
}

function formatPreview(text, maxChars = MAX_FILE_PREVIEW_CHARS) {
  const preview = truncate(String(text || ''), maxChars);
  return preview || '(empty)';
}

function walkFiles(rootDir, limit = 200) {
  const results = [];

  function visit(currentDir) {
    if (results.length >= limit) {
      return;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (results.length >= limit) {
        return;
      }

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.cache')) {
          continue;
        }
        visit(fullPath);
        continue;
      }

      if (entry.isFile()) {
        results.push(path.relative(rootDir, fullPath) || entry.name);
      }
    }
  }

  visit(rootDir);
  return results;
}

async function listWorkspaceFiles(cwd, limit = 200) {
  if (commandExists('rg')) {
    const result = await runCommand('rg', ['--files'], { cwd });
    if (result.code === 0) {
      return String(result.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, limit);
    }
  }

  return walkFiles(cwd, limit);
}

async function executeWorkspaceAction(action, cwd, env = process.env) {
  if (!action || typeof action !== 'object') {
    throw new Error('action must be an object');
  }

  const type = String(action.type || '').trim().toLowerCase();
  if (!type) {
    throw new Error('action.type is required');
  }

  if (type === 'read_file') {
    const resolved = resolveWorkspacePath(cwd, action.path);
    const content = fs.readFileSync(resolved, 'utf8');
    return {
      ok: true,
      type,
      path: path.relative(cwd, resolved),
      content,
      summary: `read ${path.relative(cwd, resolved)} (${content.length} chars)`,
    };
  }

  if (type === 'write_file') {
    const resolved = resolveWorkspacePath(cwd, action.path);
    const content = String(action.content ?? '');
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content);
    return {
      ok: true,
      type,
      path: path.relative(cwd, resolved),
      content,
      summary: `wrote ${path.relative(cwd, resolved)} (${content.length} chars)`,
    };
  }

  if (type === 'append_file') {
    const resolved = resolveWorkspacePath(cwd, action.path);
    const content = String(action.content ?? '');
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.appendFileSync(resolved, content);
    return {
      ok: true,
      type,
      path: path.relative(cwd, resolved),
      content,
      summary: `appended ${path.relative(cwd, resolved)} (${content.length} chars)`,
    };
  }

  if (type === 'replace_text') {
    const resolved = resolveWorkspacePath(cwd, action.path);
    const find = String(action.find ?? '');
    const replace = String(action.replace ?? action.replacement ?? '');
    if (!find) {
      throw new Error('replace_text requires action.find');
    }
    const original = fs.readFileSync(resolved, 'utf8');
    const updated = action.all ? original.split(find).join(replace) : original.replace(find, replace);
    fs.writeFileSync(resolved, updated);
    return {
      ok: true,
      type,
      path: path.relative(cwd, resolved),
      summary: `replaced text in ${path.relative(cwd, resolved)}`,
    };
  }

  if (type === 'mkdir') {
    const resolved = resolveWorkspacePath(cwd, action.path);
    fs.mkdirSync(resolved, { recursive: true });
    return {
      ok: true,
      type,
      path: path.relative(cwd, resolved),
      summary: `created directory ${path.relative(cwd, resolved)}`,
    };
  }

  if (type === 'list_files') {
    const target = action.path ? resolveWorkspacePath(cwd, action.path) : cwd;
    const limit = Number.isFinite(action.limit) && action.limit > 0 ? action.limit : 200;
    const files = action.path ? await listWorkspaceFiles(target, limit) : await listWorkspaceFiles(cwd, limit);
    return {
      ok: true,
      type,
      path: action.path || '.',
      files,
      summary: `listed ${files.length} files`,
    };
  }

  if (type === 'shell') {
    const command = String(action.command || '').trim();
    if (!command) {
      throw new Error('shell action requires action.command');
    }
    const args = Array.isArray(action.args) ? action.args.map((value) => String(value)) : [];
    const result = await runCommand(command, args, {
      cwd,
      env,
      input: action.input ? String(action.input) : undefined,
    });
    const stdout = truncate(result.stdout || '', MAX_SHELL_OUTPUT_CHARS);
    const stderr = truncate(result.stderr || '', MAX_SHELL_OUTPUT_CHARS);
    return {
      ok: result.code === 0,
      type,
      command,
      args,
      code: result.code,
      stdout,
      stderr,
      summary: `${command} ${args.join(' ')} -> exit ${result.code}`,
    };
  }

  throw new Error(`Unsupported action type: ${action.type}`);
}

function formatActionResult(result) {
  if (!result || typeof result !== 'object') {
    return 'No result.';
  }

  const details = [result.summary || result.type || 'action'];
  if (result.type === 'shell') {
    if (result.stdout) {
      details.push(`stdout:\n${formatPreview(result.stdout, 1200)}`);
    }
    if (result.stderr) {
      details.push(`stderr:\n${formatPreview(result.stderr, 1200)}`);
    }
  } else if (result.type === 'read_file' && result.content) {
    details.push(`content:\n${formatPreview(result.content)}`);
  } else if (result.type === 'list_files' && Array.isArray(result.files)) {
    details.push(result.files.map((file) => `- ${file}`).join('\n'));
  }

  return details.filter(Boolean).join('\n');
}

function buildAgentPrompt(snapshot, userPrompt, priorTrace = []) {
  const recentTrace = priorTrace
    .slice(-4)
    .map((entry, index) => {
      const toolSummaries = (entry.toolResults || [])
        .map((item) => formatPreview(item.summary || item.type || '', 240))
        .join(' | ');
      return [
        `Step ${index + 1}`,
        `Provider: ${entry.providerId}`,
        entry.reply ? `Reply: ${formatPreview(entry.reply, 240)}` : null,
        toolSummaries ? `Tools: ${toolSummaries}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  return [
    'You are AI Model Router running in agent mode.',
    'Act like a CLI IDE assistant: inspect the workspace, edit files, and run commands when needed.',
    'Return strict JSON only, no markdown fences and no commentary outside the JSON object.',
    'Schema:',
    '{',
    '  "done": boolean,',
    '  "summary": string,',
    '  "reply": string,',
    '  "actions": [',
    '    {"type":"read_file","path":"..."}',
    '    {"type":"write_file","path":"...","content":"..."}',
    '    {"type":"append_file","path":"...","content":"..."}',
    '    {"type":"replace_text","path":"...","find":"...","replace":"...","all":false}',
    '    {"type":"mkdir","path":"..."}',
    '    {"type":"list_files","path":"...","limit":200}',
    '    {"type":"shell","command":"npm","args":["test"]}',
    '  ]',
    '}',
    `Max actions per turn: ${MAX_ACTIONS_PER_TURN}.`,
    `Workspace:\n${snapshot.workspace || 'unknown'}`,
    snapshot.summary ? `Shared summary:\n${truncate(snapshot.summary, MAX_PROMPT_TRACE_CHARS)}` : 'Shared summary: none yet.',
    snapshot.recentExchanges && snapshot.recentExchanges.length
      ? `Recent exchanges:\n${truncate(
          snapshot.recentExchanges
            .slice(-6)
            .map((turn) => `User: ${truncate(turn.userText || '', 220)}\nAssistant: ${truncate(turn.assistantText || '', 220)}`)
            .join('\n\n'),
          MAX_PROMPT_TRACE_CHARS
        )}`
      : 'Recent exchanges: none yet.',
    recentTrace ? `Recent tool trace:\n${recentTrace}` : null,
    'Task:',
    userPrompt,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildContinuationPrompt(previousPlan, toolResults) {
  const lines = [
    'Continue the same task after these tool results.',
    'Keep returning strict JSON using the same schema.',
  ];

  if (previousPlan && previousPlan.summary) {
    lines.push(`Previous summary: ${previousPlan.summary}`);
  }

  if (toolResults && toolResults.length) {
    lines.push('Tool results:');
    for (const result of toolResults) {
      lines.push(`- ${formatActionResult(result)}`);
    }
  }

  return lines.join('\n');
}

async function runWorkspaceTask(router, userPrompt, options = {}) {
  const prompt = String(userPrompt || '').trim();
  if (!prompt) {
    throw new Error('task requires a prompt argument or piped stdin');
  }

  const maxTurns = Number.isFinite(options.maxTurns) && options.maxTurns > 0 ? options.maxTurns : 6;
  const onTurn = typeof options.onTurn === 'function' ? options.onTurn : () => {};
  const onAction = typeof options.onAction === 'function' ? options.onAction : () => {};
  const trace = [];
  let nextPrompt = prompt;
  let lastResult = null;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (typeof router.refreshProviderStatus === 'function') {
      try {
        await router.refreshProviderStatus();
      } catch {
        // Keep going with the cached snapshot if the daemon refresh fails.
      }
    }
    const snapshot = router.snapshot();
    const agentPrompt = buildAgentPrompt(snapshot, nextPrompt, trace);
    const result = await router.send(agentPrompt);
    lastResult = result;

    if (!result.ok) {
      return {
        ...result,
        mode: 'agent',
        trace,
      };
    }

    const parsed = parseAgentResponse(result.text);
    if (!parsed || typeof parsed !== 'object') {
      onTurn({
        type: 'freeform',
        result,
        text: result.text,
      });
      return {
        ...result,
        mode: 'agent',
        trace,
        parsed: null,
      };
    }

    const actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, MAX_ACTIONS_PER_TURN) : [];
    onTurn({
      type: 'plan',
      result,
      plan: parsed,
      actions,
    });

    if (actions.length === 0 || parsed.done) {
      return {
        ...result,
        mode: 'agent',
        trace,
        parsed,
      };
    }

    const toolResults = [];
    for (const action of actions) {
      const output = await executeWorkspaceAction(action, snapshot.cwd, router.env);
      toolResults.push(output);
      onAction({
        action,
        output,
      });
    }

    trace.push({
      providerId: result.providerId,
      reply: parsed.reply || '',
      summary: parsed.summary || '',
      toolResults,
    });
    nextPrompt = buildContinuationPrompt(parsed, toolResults);
  }

  return {
    ...(lastResult || { ok: false, text: '', providerId: null }),
    mode: 'agent',
    trace,
    errorMessage: 'Agent turn limit reached before the task finished',
  };
}

module.exports = {
  buildAgentPrompt,
  buildContinuationPrompt,
  executeWorkspaceAction,
  formatActionResult,
  parseAgentResponse,
  runWorkspaceTask,
};
