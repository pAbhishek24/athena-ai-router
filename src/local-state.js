const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { spawnSync } = require('child_process');
const { resolveCommand } = require('./runner');
const { getGeminiUnsupportedMessage } = require('./providers');
const { normalizeClaudeUsage, toNumber } = require('./usage');

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function pathRelated(left, right) {
  const resolvedLeft = path.resolve(left || '');
  const resolvedRight = path.resolve(right || '');

  if (resolvedLeft === resolvedRight) {
    return true;
  }

  const leftRelative = path.relative(resolvedLeft, resolvedRight);
  const rightRelative = path.relative(resolvedRight, resolvedLeft);
  return (
    (!!leftRelative && !leftRelative.startsWith('..') && !path.isAbsolute(leftRelative)) ||
    (!!rightRelative && !rightRelative.startsWith('..') && !path.isAbsolute(rightRelative))
  );
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function parseJsonSafe(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getHomeDir(env = process.env) {
  return path.resolve(env.HOME || os.homedir());
}

function findLatestCodexStateDb(env = process.env) {
  const codexHome = env.CODEX_HOME || path.join(getHomeDir(env), '.codex');
  if (!fs.existsSync(codexHome)) {
    return null;
  }

  const entries = fs
    .readdirSync(codexHome, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: path.join(codexHome, entry.name),
      version: Number(entry.name.match(/^state_(\d+)\.sqlite$/)?.[1] || 0),
      mtimeMs: fs.statSync(path.join(codexHome, entry.name)).mtimeMs,
    }));

  if (!entries.length) {
    return null;
  }

  entries.sort((left, right) => right.version - left.version || right.mtimeMs - left.mtimeMs);
  return entries[0].path;
}

function querySqlite(sqlitePath, sql, env = process.env) {
  const sqlite = resolveCommand('sqlite3', env);
  if (!sqlite) {
    return null;
  }

  const result = spawnSync(sqlite, [sqlitePath, sql], {
    env,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    return null;
  }

  return String(result.stdout || '').trim();
}

function parseUsageRow(output) {
  if (!output) {
    return null;
  }

  const [usedTokensText, lastUpdatedText, threadCountText] = String(output).trim().split('|');
  const usedTokens = Number(usedTokensText || 0);
  const lastUpdatedSeconds = Number(lastUpdatedText || 0);
  const threadCount = Number(threadCountText || 0);

  return {
    usedTokens: Number.isFinite(usedTokens) ? usedTokens : 0,
    lastUsageAt: Number.isFinite(lastUpdatedSeconds) && lastUpdatedSeconds > 0 ? new Date(lastUpdatedSeconds * 1000).toISOString() : null,
    threadCount: Number.isFinite(threadCount) ? threadCount : 0,
  };
}

function queryUsageSummary(dbPath, sql, env = process.env) {
  return parseUsageRow(querySqlite(dbPath, sql, env));
}

function pathWithinScope(scopeRoot, candidatePath) {
  const resolvedRoot = path.resolve(scopeRoot || '');
  const resolvedCandidate = path.resolve(candidatePath || '');

  if (resolvedRoot === resolvedCandidate) {
    return true;
  }

  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function collectJsonlFiles(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  files.sort();
  return files;
}

function collectJsonFiles(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(fullPath);
      }
    }
  }

  files.sort();
  return files;
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const lines = String(fs.readFileSync(filePath, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const records = [];
  for (const line of lines) {
    const record = parseJsonSafe(line);
    if (record) {
      records.push(record);
    }
  }

  return records;
}

function toTimestamp(value) {
  if (!value) {
    return null;
  }

  const millis =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : Date.parse(value);

  if (!Number.isFinite(millis)) {
    return null;
  }

  try {
    return new Date(millis).toISOString();
  } catch {
    return null;
  }
}

function addUsageTotals(target, usage) {
  if (!usage) {
    return target;
  }

  target.promptTokens += toNumber(usage.promptTokens);
  target.completionTokens += toNumber(usage.completionTokens);
  target.reasoningTokens += toNumber(usage.reasoningTokens);
  target.cachedInputTokens += toNumber(usage.cachedInputTokens);
  target.cacheCreationTokens += toNumber(usage.cacheCreationTokens);
  target.cacheReadTokens += toNumber(usage.cacheReadTokens);
  target.totalTokens += toNumber(usage.totalTokens);
  return target;
}

function createUsageTotals() {
  return {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
  };
}

function summarizeUsageEntries(entries, { source, scope, accountLabel, raw = {} } = {}) {
  if (!entries || entries.length === 0) {
    return null;
  }

  const totals = createUsageTotals();
  let lastUsageAt = null;

  for (const entry of entries) {
    addUsageTotals(totals, entry.usage);
    const timestamp = toTimestamp(entry.timestamp);
    if (timestamp && (!lastUsageAt || Date.parse(timestamp) > Date.parse(lastUsageAt))) {
      lastUsageAt = timestamp;
    }
  }

  return {
    totalTokens: totals.totalTokens,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    reasoningTokens: totals.reasoningTokens,
    cachedInputTokens: totals.cachedInputTokens,
    cacheCreationTokens: totals.cacheCreationTokens,
    cacheReadTokens: totals.cacheReadTokens,
    source,
    scope,
    raw: {
      ...raw,
      accountLabel,
      entryCount: entries.length,
      lastUsageAt,
    },
    lastUsageAt,
  };
}

function getClaudeHome(env = process.env) {
  return path.resolve(env.CLAUDE_HOME || path.join(getHomeDir(env), '.claude'));
}

function getGeminiHome(env = process.env) {
  return path.resolve(env.GEMINI_HOME || path.join(getHomeDir(env), '.gemini'));
}

function getRouterHomes(env = process.env) {
  const homes = [];
  const candidates = [];

  if (env.AI_MODEL_ROUTER_HOME) {
    candidates.push(env.AI_MODEL_ROUTER_HOME);
  }
  if (env.ATHENA_ROUTER_HOME) {
    candidates.push(env.ATHENA_ROUTER_HOME);
  }
  if (env.XDG_STATE_HOME) {
    candidates.push(path.join(env.XDG_STATE_HOME, 'ai-model-router'));
    candidates.push(path.join(env.XDG_STATE_HOME, 'athena-router'));
  }
  candidates.push(path.join(getHomeDir(env), '.ai-model-router'));
  candidates.push(path.join(getHomeDir(env), '.athena-router'));

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved) && !homes.includes(resolved)) {
      homes.push(resolved);
    }
  }

  return homes;
}

function isLocalHttpProvider(provider) {
  if (!provider || provider.transport !== 'http') {
    return false;
  }

  if (provider.id === 'ollama' || provider.id === 'lmstudio') {
    return true;
  }

  const http = provider.http || {};
  const baseUrl = String(http.baseUrl || '').trim();
  if (!baseUrl) {
    return false;
  }

  try {
    const parsed = new URL(baseUrl);
    return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function collectCodexLocalUsage(cwd, env = process.env) {
  const dbPath = findLatestCodexStateDb(env);
  if (!dbPath) {
    return null;
  }

  const resolvedCwd = path.resolve(cwd || process.cwd());
  const escapedCwd = sqlQuote(resolvedCwd);
  const sql = [
    'select',
    'coalesce(sum(tokens_used), 0) as total_tokens,',
    'coalesce(max(updated_at), 0) as last_updated_at,',
    'count(*) as thread_count',
    'from threads',
    `where cwd = ${escapedCwd}`,
    `   or cwd like ${escapedCwd} || '/%'`,
  ].join(' ');

  const projectUsage = queryUsageSummary(dbPath, sql, env);
  if (!projectUsage) {
    return null;
  }

  const accountLabel = 'ChatGPT';
  const accountUsage = queryUsageSummary(
    dbPath,
    [
      'select',
      'coalesce(sum(tokens_used), 0) as total_tokens,',
      'coalesce(max(updated_at), 0) as last_updated_at,',
      'count(*) as thread_count',
      'from threads',
    ].join(' '),
    env
  );
  const projectUsageTokens = projectUsage.usedTokens || 0;
  const accountUsageTokens = accountUsage ? accountUsage.usedTokens : projectUsageTokens;
  const statusUsage = {
    totalTokens: accountUsageTokens,
    source: 'codex-local-state',
    scope: 'account',
    raw: {
      dbPath,
      threadCount: accountUsage?.threadCount || 0,
    },
  };

  return {
    source: 'codex-local-state',
    health: 'ready',
    authState: 'ready',
    accountLabel,
    statusMessage: `Codex local state synced from ${path.basename(dbPath)}`,
    usedTokens: projectUsageTokens,
    statusUsage,
    lastUsageAt: projectUsage.lastUsageAt || null,
    observedLastUsageAt: accountUsage?.lastUsageAt || null,
    projectUsage: {
      totalTokens: projectUsageTokens,
      source: 'codex-local-state',
      scope: 'project',
      raw: {
        dbPath,
        threadCount: projectUsage.threadCount || 0,
      },
    },
    accountUsage: {
      totalTokens: accountUsageTokens,
      source: 'codex-local-state',
      scope: 'account',
      raw: {
        dbPath,
        threadCount: accountUsage?.threadCount || 0,
      },
    },
    raw: {
      dbPath,
      project: projectUsage || null,
      account: accountUsage || null,
    },
  };
}

function collectCodexDoctorSnapshot(env = process.env) {
  const codex = resolveCommand('codex', env);
  if (!codex) {
    return null;
  }

  const codexHome = env.CODEX_HOME || path.join(getHomeDir(env), '.codex');
  const authFile = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(authFile)) {
    return null;
  }

  const result = spawnSync(codex, ['doctor', '--json'], {
    env,
    encoding: 'utf8',
  });
  const payload = parseJsonSafe(String(result.stdout || '').trim());
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const authCheck = payload.checks && payload.checks['auth.credentials'] ? payload.checks['auth.credentials'] : null;
  const installationCheck = payload.checks && payload.checks.installation ? payload.checks.installation : null;
  const authState = authCheck && authCheck.status === 'ok' ? 'ready' : authCheck && authCheck.status === 'fail' ? 'auth' : 'unknown';
  const health = installationCheck && installationCheck.status === 'fail' ? 'missing' : authState === 'auth' ? 'auth' : 'ready';
  const accountLabel = authCheck && authCheck.details && authCheck.details['stored auth mode'] === 'chatgpt' ? 'ChatGPT' : 'Codex';
  const statusMessage =
    (authCheck && authCheck.summary) ||
    (installationCheck && installationCheck.summary) ||
    payload.overallStatus ||
    'Codex doctor checked';

  return {
    source: 'codex-doctor',
    health,
    authState,
    accountLabel,
    statusMessage,
    raw: payload,
  };
}

function collectCodexSnapshot(cwd, env = process.env) {
  const usage = collectCodexLocalUsage(cwd, env);
  const doctor = collectCodexDoctorSnapshot(env);
  if (!usage && !doctor) {
    return null;
  }

  return {
    source: usage?.source || doctor?.source || 'codex',
    health: doctor?.health || usage?.health || 'ready',
    authState: doctor?.authState || usage?.authState || 'unknown',
    accountLabel: doctor?.accountLabel || usage?.accountLabel || 'Codex',
    statusMessage: usage?.statusMessage || doctor?.statusMessage || null,
    usedTokens: usage?.usedTokens || 0,
    projectUsedTokens: usage?.usedTokens || 0,
    accountUsedTokens: usage?.statusUsage?.totalTokens || usage?.accountUsage?.totalTokens || usage?.usedTokens || 0,
    effectiveUsedTokens: usage?.statusUsage?.totalTokens || usage?.accountUsage?.totalTokens || usage?.usedTokens || 0,
    statusUsage: usage?.statusUsage || null,
    observedUsage: usage?.statusUsage || null,
    lastUsageAt: usage?.lastUsageAt || null,
    observedLastUsageAt: usage?.observedLastUsageAt || null,
    raw: {
      projectUsage: usage?.projectUsage || null,
      accountUsage: usage?.accountUsage || null,
      usage: usage?.raw || null,
      doctor: doctor?.raw || null,
    },
  };
}

function collectClaudeSnapshot(cwd, env = process.env) {
  const claudeHome = getClaudeHome(env);
  const files = collectJsonlFiles(path.join(claudeHome, 'projects'));
  if (!files.length) {
    return null;
  }

  const accountEntries = new Map();
  const projectEntries = new Map();

  for (const file of files) {
    const records = readJsonLines(file);
    for (const record of records) {
      const message = record && record.message && typeof record.message === 'object' ? record.message : null;
      if (!message || message.role !== 'assistant' || !message.usage) {
        continue;
      }

      const id = String(message.id || record.uuid || `${file}:${accountEntries.size}`).trim();
      const entry = {
        id,
        timestamp: record.timestamp || message.timestamp || null,
        cwd: typeof record.cwd === 'string' ? record.cwd : null,
        usage: normalizeClaudeUsage(message.usage),
      };

      if (!id) {
        continue;
      }

      accountEntries.set(id, entry);
      if (entry.cwd && pathWithinScope(cwd, entry.cwd)) {
        projectEntries.set(id, entry);
      }
    }
  }

  const accountUsage = summarizeUsageEntries([...accountEntries.values()], {
    source: 'claude-local-history',
    scope: 'account',
    accountLabel: 'Claude',
    raw: {
      home: claudeHome,
      fileCount: files.length,
    },
  });
  const projectUsage = summarizeUsageEntries([...projectEntries.values()], {
    source: 'claude-local-history',
    scope: 'project',
    accountLabel: 'Claude',
    raw: {
      home: claudeHome,
      fileCount: files.length,
    },
  });

  if (!accountUsage && !projectUsage) {
    return null;
  }

  const effectiveUsage = accountUsage || projectUsage || null;

  return {
    source: 'claude-local-history',
    health: files.length > 0 ? 'ready' : 'unknown',
    authState: files.length > 0 ? 'ready' : 'unknown',
    accountLabel: 'Claude',
    statusMessage: effectiveUsage
      ? `Claude history synced from ${files.length} project files`
      : 'Claude history unavailable',
    usedTokens: projectUsage ? projectUsage.totalTokens : 0,
    projectUsedTokens: projectUsage ? projectUsage.totalTokens : 0,
    accountUsedTokens: effectiveUsage ? effectiveUsage.totalTokens : 0,
    effectiveUsedTokens: effectiveUsage ? effectiveUsage.totalTokens : 0,
    statusUsage: accountUsage || null,
    observedUsage: effectiveUsage,
    lastUsageAt: projectUsage ? projectUsage.lastUsageAt || null : null,
    observedLastUsageAt: effectiveUsage ? effectiveUsage.lastUsageAt || null : null,
    projectUsage: projectUsage || null,
    accountUsage: accountUsage || null,
    raw: {
      home: claudeHome,
      fileCount: files.length,
      projectEntryCount: projectEntries.size,
      accountEntryCount: accountEntries.size,
    },
  };
}

function collectGeminiSnapshot(env = process.env) {
  const geminiHome = getGeminiHome(env);
  const files = collectJsonlFiles(geminiHome).filter((file) => file.includes(`${path.sep}chats${path.sep}`));
  if (!files.length) {
    return null;
  }

  const accountEntries = new Map();

  for (const file of files) {
    const records = readJsonLines(file);
    for (const record of records) {
      if (record.type !== 'gemini' || !record.tokens) {
        continue;
      }

      const id = String(record.id || `${file}:${accountEntries.size}`).trim();
      if (!id) {
        continue;
      }

      accountEntries.set(id, {
        id,
        timestamp: record.timestamp || null,
        usage: {
          promptTokens: toNumber(record.tokens.input),
          completionTokens: toNumber(record.tokens.output),
          reasoningTokens: toNumber(record.tokens.thoughts),
          cachedInputTokens: toNumber(record.tokens.cached),
          cacheCreationTokens: 0,
          cacheReadTokens: toNumber(record.tokens.cached),
          totalTokens: toNumber(record.tokens.total),
        },
      });
    }
  }

  const accountUsage = summarizeUsageEntries([...accountEntries.values()], {
    source: 'gemini-local-history',
    scope: 'account',
    accountLabel: readJsonSafe(path.join(geminiHome, 'google_accounts.json'))?.active || 'Gemini',
    raw: {
      home: geminiHome,
      fileCount: files.length,
    },
  });

  if (!accountUsage) {
    return null;
  }

  const activeAccount = readJsonSafe(path.join(geminiHome, 'google_accounts.json'))?.active || 'Gemini';

  return {
    source: 'gemini-local-history',
    health: 'disabled',
    authState: 'disabled',
    accountLabel: activeAccount,
    statusMessage: getGeminiUnsupportedMessage(),
    usedTokens: 0,
    projectUsedTokens: 0,
    accountUsedTokens: accountUsage.totalTokens,
    effectiveUsedTokens: accountUsage.totalTokens,
    statusUsage: accountUsage,
    observedUsage: accountUsage,
    lastUsageAt: null,
    observedLastUsageAt: accountUsage.lastUsageAt || null,
    projectUsage: null,
    accountUsage,
    raw: {
      home: geminiHome,
      fileCount: files.length,
      accountEntryCount: accountEntries.size,
    },
  };
}

function collectRouterStateUsage(providerId, cwd, env = process.env) {
  const homes = getRouterHomes(env);
  const projectEntries = new Map();
  const accountEntries = new Map();

  for (const home of homes) {
    const projectsDir = path.join(home, 'projects');
    if (!fs.existsSync(projectsDir)) {
      continue;
    }

    for (const file of collectJsonFiles(projectsDir)) {
      const state = readJsonSafe(file);
      const project = state && state.project && typeof state.project === 'object' ? state.project : null;
      const stats = state && state.providerState && state.providerState[providerId] ? state.providerState[providerId] : null;
      if (!project || !stats) {
        continue;
      }

      const projectKey = String(project.key || path.basename(file, '.json')).trim();
      const timestamp = stats.lastUsageAt || project.updatedAt || project.createdAt || null;
      const entry = {
        id: projectKey,
        timestamp,
        cwd: project.cwd || null,
        usage: {
          promptTokens: toNumber(stats.promptTokens),
          completionTokens: toNumber(stats.completionTokens),
          reasoningTokens: toNumber(stats.reasoningTokens),
          cachedInputTokens: toNumber(stats.cachedInputTokens),
          cacheCreationTokens: toNumber(stats.cacheCreationTokens),
          cacheReadTokens: toNumber(stats.cacheReadTokens),
          totalTokens: toNumber(stats.usedTokens),
        },
      };

      const existing = accountEntries.get(projectKey);
      if (!existing || (timestamp && (!existing.timestamp || Date.parse(timestamp) > Date.parse(existing.timestamp)))) {
        accountEntries.set(projectKey, entry);
      }

      if (entry.cwd && pathWithinScope(cwd, entry.cwd)) {
        const existingProject = projectEntries.get(projectKey);
        if (!existingProject || (timestamp && (!existingProject.timestamp || Date.parse(timestamp) > Date.parse(existingProject.timestamp)))) {
          projectEntries.set(projectKey, entry);
        }
      }
    }
  }

  const accountUsage = summarizeUsageEntries([...accountEntries.values()], {
    source: 'router-project-state',
    scope: 'account',
    accountLabel: 'Router state',
    raw: {
      homeCount: homes.length,
      providerId,
    },
  });
  const projectUsage = summarizeUsageEntries([...projectEntries.values()], {
    source: 'router-project-state',
    scope: 'project',
    accountLabel: 'Router state',
    raw: {
      homeCount: homes.length,
      providerId,
    },
  });

  if (!accountUsage && !projectUsage) {
    return null;
  }

  const effectiveUsage = accountUsage || projectUsage || null;

  return {
    source: 'router-project-state',
    health: accountUsage || projectUsage ? 'ready' : 'unknown',
    authState: accountUsage || projectUsage ? 'ready' : 'unknown',
    accountLabel: 'Router state',
    statusMessage: accountUsage
      ? `Router state synced from ${accountEntries.size} project files`
      : 'Router state unavailable',
    usedTokens: projectUsage ? projectUsage.totalTokens : 0,
    projectUsedTokens: projectUsage ? projectUsage.totalTokens : 0,
    accountUsedTokens: effectiveUsage ? effectiveUsage.totalTokens : 0,
    effectiveUsedTokens: effectiveUsage ? effectiveUsage.totalTokens : 0,
    statusUsage: accountUsage || null,
    observedUsage: effectiveUsage,
    lastUsageAt: projectUsage ? projectUsage.lastUsageAt || null : null,
    observedLastUsageAt: effectiveUsage ? effectiveUsage.lastUsageAt || null : null,
    projectUsage: projectUsage || null,
    accountUsage: accountUsage || null,
    raw: {
      homeCount: homes.length,
      providerId,
      projectEntryCount: projectEntries.size,
      accountEntryCount: accountEntries.size,
    },
  };
}

function collectProviderSnapshot(provider, cwd, env = process.env) {
  if (!provider || typeof provider !== 'object') {
    return null;
  }

  if (provider.id === 'codex') {
    return collectCodexSnapshot(cwd, env);
  }

  if (provider.id === 'claude') {
    return collectClaudeSnapshot(cwd, env);
  }

  if (provider.id === 'gemini') {
    return collectGeminiSnapshot(env);
  }

  if (isLocalHttpProvider(provider)) {
    return collectRouterStateUsage(provider.id, cwd, env);
  }

  return null;
}

module.exports = {
  collectClaudeSnapshot,
  collectCodexLocalUsage,
  collectCodexSnapshot,
  collectGeminiSnapshot,
  collectProviderSnapshot,
  collectRouterStateUsage,
  findLatestCodexStateDb,
  getClaudeHome,
  getGeminiHome,
  getRouterHomes,
  isLocalHttpProvider,
  pathRelated,
  pathWithinScope,
  parseUsageRow,
  queryUsageSummary,
  readJsonLines,
};
