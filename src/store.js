const fs = require('fs');
const path = require('path');
const { ensureRouterStructure, getProjectKey, getProjectStatePath } = require('./paths');

function createProviderStats(provider, limitOverride) {
  const budget = Number.isFinite(limitOverride) ? limitOverride : provider.budgetTokens || 0;
  return {
    limitTokens: budget,
    usedTokens: 0,
    projectUsedTokens: 0,
    effectiveUsedTokens: 0,
    accountUsedTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTurns: 0,
    health: 'unknown',
    authState: 'unknown',
    accountLabel: null,
    statusMessage: null,
    statusUsage: null,
    observedUsage: null,
    projectUsage: null,
    accountUsage: null,
    statusRaw: null,
    lastError: null,
    lastSessionRef: null,
    lastUsageAt: null,
    lastStatusAt: null,
  };
}

function createDefaultState(config, cwd, env = process.env) {
  const now = new Date().toISOString();
  const providerState = {};

  for (const provider of config.providers) {
    providerState[provider.id] = createProviderStats(provider);
  }

  return {
    version: 1,
    project: {
      cwd: path.resolve(cwd),
      key: getProjectKey(cwd),
      createdAt: now,
      updatedAt: now,
    },
    activeProviderId: config.defaultProviderId || config.providers[0]?.id || null,
    summary: '',
    recentExchanges: [],
    handoffs: [],
    providerState,
  };
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function mergeProviderState(existingState = {}, config) {
  const merged = {};
  for (const provider of config.providers) {
    const current = existingState[provider.id] || {};
    merged[provider.id] = {
      ...createProviderStats(provider, current.limitTokens),
      ...current,
      limitTokens: Number.isFinite(current.limitTokens) ? current.limitTokens : provider.budgetTokens || 0,
    };
  }
  return merged;
}

function normalizeLoadedState(state, config, cwd, env = process.env) {
  const base = createDefaultState(config, cwd, env);
  if (!state || typeof state !== 'object') {
    return base;
  }

  const merged = {
    ...base,
    ...state,
    project: {
      ...base.project,
      ...(state.project || {}),
      cwd: path.resolve(cwd),
      key: getProjectKey(cwd),
      updatedAt: new Date().toISOString(),
    },
    providerState: mergeProviderState(state.providerState || {}, config),
    summary: typeof state.summary === 'string' ? state.summary : '',
    recentExchanges: Array.isArray(state.recentExchanges) ? state.recentExchanges.slice() : [],
    handoffs: Array.isArray(state.handoffs) ? state.handoffs.slice() : [],
  };

  if (!config.providers.some((provider) => provider.id === merged.activeProviderId)) {
    merged.activeProviderId = config.defaultProviderId || config.providers[0]?.id || null;
  }

  return merged;
}

function getStatePath(cwd, env = process.env) {
  return getProjectStatePath(cwd, env);
}

function loadState(config, cwd, env = process.env) {
  ensureRouterStructure(env);
  const statePath = getStatePath(cwd, env);
  const loaded = readJsonFile(statePath);
  const state = normalizeLoadedState(loaded, config, cwd, env);
  return { state, statePath, exists: !!loaded };
}

function saveState(state, statePath, env = process.env) {
  ensureRouterStructure(env);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return statePath;
}

function appendExchange(state, exchange, maxRecentExchanges = 18) {
  state.recentExchanges.push(exchange);
  if (state.recentExchanges.length > maxRecentExchanges) {
    const overflow = state.recentExchanges.splice(0, state.recentExchanges.length - maxRecentExchanges);
    const overflowSummary = overflow
      .map((turn) => {
        const user = turn.userText ? `User: ${truncate(turn.userText, 180)}` : '';
        const assistant = turn.assistantText ? `Assistant (${turn.providerId}): ${truncate(turn.assistantText, 180)}` : '';
        return [user, assistant].filter(Boolean).join(' ');
      })
      .filter(Boolean)
      .join('\n');
    state.summary = [state.summary, overflowSummary].filter(Boolean).join('\n').trim();
    if (state.summary.length > 6000) {
      state.summary = `...${state.summary.slice(-6000)}`;
    }
  }
}

function truncate(text, maxChars) {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function recordHandoff(state, handoff) {
  state.handoffs.push({ ...handoff, at: new Date().toISOString() });
  if (state.handoffs.length > 12) {
    state.handoffs = state.handoffs.slice(-12);
  }
}

function updateProviderUsage(state, providerId, usage, sessionRef, errorMessage) {
  const provider = state.providerState[providerId];
  if (!provider) {
    return;
  }

  provider.usedTokens += Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0;
  provider.projectUsedTokens = provider.usedTokens;
  if (!Number.isFinite(provider.effectiveUsedTokens) || provider.effectiveUsedTokens < provider.usedTokens) {
    provider.effectiveUsedTokens = provider.usedTokens;
  }
  if (!Number.isFinite(provider.accountUsedTokens) || provider.accountUsedTokens < provider.effectiveUsedTokens) {
    provider.accountUsedTokens = provider.effectiveUsedTokens;
  }
  provider.promptTokens += Number.isFinite(usage.promptTokens) ? usage.promptTokens : 0;
  provider.completionTokens += Number.isFinite(usage.completionTokens) ? usage.completionTokens : 0;
  provider.reasoningTokens += Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : 0;
  provider.cachedInputTokens += Number.isFinite(usage.cachedInputTokens) ? usage.cachedInputTokens : 0;
  provider.cacheCreationTokens += Number.isFinite(usage.cacheCreationTokens) ? usage.cacheCreationTokens : 0;
  provider.cacheReadTokens += Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0;
  provider.totalTurns += 1;
  provider.health = errorMessage ? provider.health : 'ready';
  provider.lastError = errorMessage || null;
  provider.lastSessionRef = sessionRef || provider.lastSessionRef || null;
  provider.lastUsageAt = new Date().toISOString();
}

module.exports = {
  appendExchange,
  createDefaultState,
  getStatePath,
  loadState,
  normalizeLoadedState,
  recordHandoff,
  saveState,
  truncate,
  updateProviderUsage,
};
