const path = require('path');
const { spawnSync } = require('child_process');
const { executeProvider, getProviderTransport, probeProviderStatus, resolveProviderCommand, classifyFailure: classifyProviderFailure } = require('./providers');
const { commandExists, runCommand } = require('./runner');
const { appendExchange, recordHandoff, saveState, truncate, updateProviderUsage } = require('./store');
const { estimateTokens } = require('./usage');

const DEFAULT_RESERVED_OUTPUT_TOKENS = 1024;
const UNAVAILABLE_HEALTH = new Set(['missing', 'auth', 'sandbox', 'offline']);

function compactText(text, maxChars) {
  return truncate(String(text || ''), maxChars);
}

function formatTurn(turn) {
  const lines = [];
  if (turn.userText) {
    lines.push(`User: ${compactText(turn.userText, 320)}`);
  }
  if (turn.assistantText) {
    lines.push(`Assistant (${turn.providerId}): ${compactText(turn.assistantText, 320)}`);
  }
  return lines.join('\n');
}

function collectWorkspaceContext(cwd) {
  if (!commandExists('git')) {
    return `cwd: ${path.resolve(cwd)}`;
  }

  const checkRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    encoding: 'utf8',
  });

  if (checkRepo.status !== 0 || !String(checkRepo.stdout || '').trim().includes('true')) {
    return `cwd: ${path.resolve(cwd)}`;
  }

  const branch = spawnSync('git', ['branch', '--show-current'], {
    cwd,
    encoding: 'utf8',
  });
  const status = spawnSync('git', ['status', '--short'], {
    cwd,
    encoding: 'utf8',
  });

  const lines = [`cwd: ${path.resolve(cwd)}`];
  lines.push(`git branch: ${String(branch.stdout || '').trim() || 'detached'}`);
  const statusText = String(status.stdout || '').trim();
  lines.push(statusText ? `git status:\n${statusText}` : 'git status: clean');
  return lines.join('\n');
}

function buildContextPreview(state, cwd, prompt) {
  const summary = state.summary ? compactText(state.summary, 2600) : '';
  const recent = state.recentExchanges
    .slice(-8)
    .map((turn, index) => `Turn ${index + 1}\n${formatTurn(turn)}`)
    .join('\n\n');
  const workspace = collectWorkspaceContext(cwd);
  return [
    'You are a continuation model in a shared multi-CLI router.',
    'Preserve established decisions and avoid re-litigating resolved context.',
    `Workspace:\n${workspace}`,
    summary ? `Shared summary:\n${summary}` : 'Shared summary: none yet.',
    recent ? `Recent exchanges:\n${recent}` : 'Recent exchanges: none yet.',
    'Current user request:',
    prompt,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildHandoffNote({ fromProvider, toProvider, reason, usedTokens, limitTokens, projectedTokens, errorMessage }) {
  if (reason === 'threshold') {
    const percent = limitTokens > 0 ? ((usedTokens / limitTokens) * 100).toFixed(1) : '0.0';
    return `${fromProvider.label} reached ${percent}% of its budget (${usedTokens}/${limitTokens}). Continue in ${toProvider.label} without dropping the task state.`;
  }

  if (reason === 'failure') {
    return `${fromProvider.label} failed with ${errorMessage || 'an unavailable state'}. Continue in ${toProvider.label} using the same shared context.`;
  }

  if (reason === 'manual') {
    return `Manual switch from ${fromProvider.label} to ${toProvider.label}. Continue with the same task context.`;
  }

  if (reason === 'projected') {
    const projectedPercent = limitTokens > 0 ? ((projectedTokens / limitTokens) * 100).toFixed(1) : '0.0';
    return `${fromProvider.label} would exceed the threshold with this turn (${projectedPercent}% projected). Continue in ${toProvider.label}.`;
  }

  return `${fromProvider.label} handed off to ${toProvider.label}. Continue with the same context.`;
}

function getProviderStats(state, providerId) {
  return state.providerState[providerId] || {
    limitTokens: 0,
    usedTokens: 0,
    health: 'unknown',
  };
}

function getProviderHealth(state, providerId) {
  return getProviderStats(state, providerId).health || 'unknown';
}

function getProviderLimit(state, providerId, fallbackLimit = 0) {
  const stats = getProviderStats(state, providerId);
  return Number.isFinite(stats.limitTokens) && stats.limitTokens > 0 ? stats.limitTokens : fallbackLimit;
}

function getProviderUsed(state, providerId) {
  return Number.isFinite(getProviderStats(state, providerId).usedTokens) ? getProviderStats(state, providerId).usedTokens : 0;
}

function providerHeadroomRatio(state, provider) {
  const limit = getProviderLimit(state, provider.id, provider.budgetTokens || 0);
  const used = getProviderUsed(state, provider.id);
  if (!limit) {
    return 1;
  }
  return Math.max(0, (limit - used) / limit);
}

function isProviderAvailable(state, provider) {
  if (provider.enabled === false) {
    return false;
  }

  const health = getProviderHealth(state, provider.id);
  if (UNAVAILABLE_HEALTH.has(health)) {
    return false;
  }

  if (getProviderTransport(provider) === 'http') {
    return !!(provider.http && provider.http.baseUrl);
  }

  return !!resolveProviderCommand(provider);
}

function chooseActiveProvider(config, state) {
  const byId = new Map(config.providers.map((provider) => [provider.id, provider]));
  if (state.activeProviderId && byId.has(state.activeProviderId)) {
    return byId.get(state.activeProviderId);
  }
  if (config.defaultProviderId && byId.has(config.defaultProviderId)) {
    return byId.get(config.defaultProviderId);
  }
  return config.providers[0] || null;
}

function buildProviderOrder(config, state) {
  const active = chooseActiveProvider(config, state);
  const providers = config.providers.filter((provider) => provider.enabled !== false);
  const rest = providers
    .filter((provider) => !active || provider.id !== active.id)
    .sort((left, right) => {
      const headroomDifference = providerHeadroomRatio(state, right) - providerHeadroomRatio(state, left);
      if (Math.abs(headroomDifference) > 0.0001) {
        return headroomDifference;
      }
      return config.providers.findIndex((provider) => provider.id === left.id) - config.providers.findIndex((provider) => provider.id === right.id);
    });
  return active ? [active, ...rest] : rest;
}

function pickFallbackProvider(config, state, excludeId) {
  const candidates = config.providers
    .filter((provider) => provider.enabled !== false && provider.id !== excludeId && isProviderAvailable(state, provider))
    .filter((provider) => !UNAVAILABLE_HEALTH.has(getProviderHealth(state, provider.id)))
    .sort((left, right) => {
      const ratioDifference = providerHeadroomRatio(state, right) - providerHeadroomRatio(state, left);
      if (Math.abs(ratioDifference) > 0.0001) {
        return ratioDifference;
      }
      return config.providers.findIndex((provider) => provider.id === left.id) - config.providers.findIndex((provider) => provider.id === right.id);
    });
  return candidates[0] || null;
}

class Router {
  constructor({ config, state, cwd, env = process.env, runner = runCommand, fetchImpl = globalThis.fetch, statePath = null, persist = true } = {}) {
    this.config = config;
    this.state = state;
    this.cwd = path.resolve(cwd || process.cwd());
    this.env = env;
    this.runner = typeof runner === 'function' ? runner : runCommand;
    this.fetchImpl = fetchImpl;
    this.statePath = statePath;
    this.persist = persist;
  }

  save() {
    if (this.persist && this.statePath) {
      saveState(this.state, this.statePath, this.env);
    }
  }

  async refreshProviderStatus() {
    for (const provider of this.config.providers) {
      if (provider.enabled === false) {
        continue;
      }

      const stats = getProviderStats(this.state, provider.id);
      try {
        const status = await probeProviderStatus(provider, {
          cwd: this.cwd,
          env: this.env,
          runner: this.runner,
          fetchImpl: this.fetchImpl,
        });

        if (status.health) {
          stats.health = status.health;
        }
        if (status.authState) {
          stats.authState = status.authState;
        }
        if (Object.prototype.hasOwnProperty.call(status, 'accountLabel')) {
          stats.accountLabel = status.accountLabel;
        }
        if (status.statusMessage !== undefined) {
          stats.statusMessage = status.statusMessage;
        }
        if (Object.prototype.hasOwnProperty.call(status, 'usage')) {
          stats.statusUsage = status.usage || null;
        }
        if (Object.prototype.hasOwnProperty.call(status, 'raw')) {
          stats.statusRaw = status.raw || null;
        }
        if (status.lastStatusAt) {
          stats.lastStatusAt = status.lastStatusAt;
        }
        stats.lastError = null;
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        stats.health = classifyProviderFailure(message);
        stats.lastError = message;
        stats.authState = 'error';
        stats.statusMessage = message;
        stats.lastStatusAt = new Date().toISOString();
      }
    }
  }

  refreshProviderHealth() {
    for (const provider of this.config.providers) {
      if (provider.enabled === false) {
        continue;
      }

      const stats = getProviderStats(this.state, provider.id);
      if (getProviderTransport(provider) === 'http') {
        if (!provider.http || !provider.http.baseUrl) {
          stats.health = 'missing';
          stats.lastError = `HTTP provider ${provider.id} is missing http.baseUrl`;
        } else if (!stats.health || stats.health === 'unknown' || stats.health === 'missing') {
          stats.health = 'ready';
          stats.lastError = null;
        }
      } else if (!resolveProviderCommand(provider, this.env)) {
        stats.health = 'missing';
        stats.lastError = `Command not found: ${provider.commandCandidates && provider.commandCandidates.length ? provider.commandCandidates.join(', ') : provider.command}`;
      } else if (!stats.health || stats.health === 'unknown' || stats.health === 'missing') {
        stats.health = 'ready';
        stats.lastError = null;
      }
    }
  }

  buildPromptEnvelope(provider, prompt, handoffNote = '') {
    const contextPreview = buildContextPreview(this.state, this.cwd, prompt);
    const providerName = provider.label || provider.id;
    return [
      'You are one of several CLI models working on the same task.',
      'Preserve context and continue from the shared ledger below.',
      `Target provider: ${providerName} (${provider.id})`,
      handoffNote ? `Handoff note: ${handoffNote}` : 'Handoff note: none.',
      contextPreview,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  estimateRequestTokens(prompt) {
    return estimateTokens(buildContextPreview(this.state, this.cwd, prompt));
  }

  chooseProviderForPrompt(prompt) {
    this.refreshProviderHealth();
    const providerOrder = buildProviderOrder(this.config, this.state);
    const active = providerOrder[0] || null;
    const estimatedRequestTokens = this.estimateRequestTokens(prompt);
    const threshold = this.config.switchThreshold || 0.99;

    for (const provider of providerOrder) {
      if (!isProviderAvailable(this.state, provider)) {
        continue;
      }

      const limit = getProviderLimit(this.state, provider.id, provider.budgetTokens || 0);
      const used = getProviderUsed(this.state, provider.id);
      const projectedTokens = used + estimatedRequestTokens + DEFAULT_RESERVED_OUTPUT_TOKENS;
      const projectedRatio = limit > 0 ? projectedTokens / limit : 0;
      const isActive = active && provider.id === active.id;

      if (isActive && limit > 0 && projectedRatio >= threshold) {
        continue;
      }

      return {
        provider,
        reason: isActive ? 'active' : 'fallback',
        previousActiveId: active ? active.id : null,
        estimatedRequestTokens,
        projectedTokens,
        limit,
        used,
      };
    }

    const fallback = pickFallbackProvider(this.config, this.state, active ? active.id : null);
    if (fallback) {
      const limit = getProviderLimit(this.state, fallback.id, fallback.budgetTokens || 0);
      const used = getProviderUsed(this.state, fallback.id);
      return {
        provider: fallback,
        reason: 'fallback',
        previousActiveId: active ? active.id : null,
        estimatedRequestTokens,
        projectedTokens: used + estimatedRequestTokens + DEFAULT_RESERVED_OUTPUT_TOKENS,
        limit,
        used,
      };
    }

    return null;
  }

  setActiveProvider(providerId, reason = 'manual') {
    const provider = this.config.providers.find((candidate) => candidate.id === providerId);
    if (!provider) {
      return false;
    }

    const previousActiveId = this.state.activeProviderId;
    this.state.activeProviderId = provider.id;
    if (previousActiveId && previousActiveId !== provider.id) {
      recordHandoff(this.state, {
        fromProviderId: previousActiveId,
        toProviderId: provider.id,
        reason,
        detail: reason === 'manual' ? 'manual switch' : reason,
      });
    }
    this.save();
    return true;
  }

  snapshot() {
    this.refreshProviderHealth();
    const activeProvider = chooseActiveProvider(this.config, this.state);
    const providerViews = this.config.providers.map((provider) => {
      const limit = getProviderLimit(this.state, provider.id, provider.budgetTokens || 0);
      const used = getProviderUsed(this.state, provider.id);
      const remaining = Math.max(0, limit - used);
      const ratio = limit > 0 ? used / limit : 0;
      const stats = getProviderStats(this.state, provider.id);
      const transport = getProviderTransport(provider);
      const target = transport === 'http'
        ? (() => {
            const http = provider.http || {};
            if (http.baseUrl) {
              try {
                return new URL(http.path || '/', http.baseUrl).toString();
              } catch {
                return http.baseUrl;
              }
            }
            return http.path || '';
          })()
        : provider.commandCandidates && provider.commandCandidates.length > 0
          ? provider.commandCandidates.join(', ')
          : provider.command || '';
      return {
        id: provider.id,
        label: provider.label,
        command: provider.command,
        target,
        transport,
        model: provider.model || '',
        enabled: provider.enabled !== false,
        health: provider.enabled === false ? 'disabled' : stats.health || 'unknown',
        authState: stats.authState || 'unknown',
        accountLabel: stats.accountLabel || null,
        statusMessage: stats.statusMessage || null,
        statusUsage: stats.statusUsage || null,
        usedTokens: used,
        limitTokens: limit,
        remainingTokens: remaining,
        ratio,
        ratioPercent: Number.isFinite(ratio) ? ratio * 100 : 0,
        totalTurns: stats.totalTurns || 0,
        lastError: stats.lastError || null,
        lastSessionRef: stats.lastSessionRef || null,
        lastStatusAt: stats.lastStatusAt || null,
        isActive: activeProvider ? activeProvider.id === provider.id : false,
      };
    });

    const activeView = providerViews.find((provider) => provider.isActive) || providerViews[0] || null;
    const nextProvider = pickFallbackProvider(this.config, this.state, activeProvider ? activeProvider.id : null);
    const totalUsedTokens = providerViews.reduce((sum, provider) => sum + provider.usedTokens, 0);
    const totalLimitTokens = providerViews.reduce((sum, provider) => sum + provider.limitTokens, 0);

    return {
      cwd: this.cwd,
      project: this.state.project,
      activeProviderId: this.state.activeProviderId,
      activeProvider: activeView,
      nextProvider: nextProvider
        ? {
            id: nextProvider.id,
            label: nextProvider.label,
            usedTokens: getProviderUsed(this.state, nextProvider.id),
            limitTokens: getProviderLimit(this.state, nextProvider.id, nextProvider.budgetTokens || 0),
          }
        : null,
      threshold: this.config.switchThreshold || 0.99,
      providerViews,
      summary: this.state.summary || '',
      recentExchanges: this.state.recentExchanges || [],
      handoffs: this.state.handoffs || [],
      workspace: collectWorkspaceContext(this.cwd),
      dashboard: this.config.dashboard || {},
      totalUsedTokens,
      totalLimitTokens,
    };
  }

  async send(prompt) {
    await this.refreshProviderStatus();
    this.refreshProviderHealth();
    const snapshotBeforeTurn = this.snapshot();
    const providerOrder = buildProviderOrder(this.config, this.state);
    const activeProvider = chooseActiveProvider(this.config, this.state);
    const initialActiveId = activeProvider ? activeProvider.id : null;
    const threshold = this.config.switchThreshold || 0.99;
    const estimatedRequestTokens = this.estimateRequestTokens(prompt);
    const activeLimit = activeProvider ? getProviderLimit(this.state, activeProvider.id, activeProvider.budgetTokens || 0) : 0;
    const activeUsed = activeProvider ? getProviderUsed(this.state, activeProvider.id) : 0;
    const activeAvailable = activeProvider ? isProviderAvailable(this.state, activeProvider) : false;
    const activeHealth = activeProvider ? getProviderHealth(this.state, activeProvider.id) : 'unknown';
    const activeErrorMessage = activeProvider ? getProviderStats(this.state, activeProvider.id).lastError || activeHealth : activeHealth;
    const activeProjectedRatio = activeLimit > 0 ? (activeUsed + estimatedRequestTokens + DEFAULT_RESERVED_OUTPUT_TOKENS) / activeLimit : 0;
    const activeShouldSwitch = !!(
      activeProvider &&
      providerOrder.length > 1 &&
      ((!activeAvailable && initialActiveId) || (activeLimit > 0 && activeProjectedRatio >= threshold))
    );

    let pendingHandoffFrom = activeProvider;
    let pendingHandoffReason = activeShouldSwitch ? (!activeAvailable ? 'failure' : 'threshold') : 'active';
    let pendingHandoffErrorMessage = activeShouldSwitch && !activeAvailable ? activeErrorMessage : null;
    let lastFailure = null;

    for (let index = 0; index < providerOrder.length; index += 1) {
      const provider = providerOrder[index];
      const isActive = activeProvider && provider.id === activeProvider.id;

      if (isActive && activeShouldSwitch) {
        continue;
      }

      if (!isProviderAvailable(this.state, provider)) {
        lastFailure = {
          providerId: provider.id,
          errorMessage: `Provider ${provider.id} is unavailable`,
          failureType: getProviderHealth(this.state, provider.id) || 'missing',
        };
        pendingHandoffFrom = provider;
        pendingHandoffReason = 'failure';
        pendingHandoffErrorMessage = lastFailure.errorMessage;
        continue;
      }

      const handoffNote =
        pendingHandoffFrom && pendingHandoffFrom.id !== provider.id
          ? buildHandoffNote({
              fromProvider: pendingHandoffFrom,
              toProvider: provider,
              reason: pendingHandoffReason === 'active' ? 'manual' : pendingHandoffReason,
              usedTokens: getProviderUsed(this.state, pendingHandoffFrom.id),
              limitTokens: getProviderLimit(this.state, pendingHandoffFrom.id, pendingHandoffFrom.budgetTokens || 0),
              projectedTokens: getProviderUsed(this.state, provider.id) + estimatedRequestTokens + DEFAULT_RESERVED_OUTPUT_TOKENS,
              errorMessage: pendingHandoffErrorMessage,
            })
          : '';

      const envelope = this.buildPromptEnvelope(provider, prompt, handoffNote);
      const sessionRef = getProviderStats(this.state, provider.id).lastSessionRef || null;

      let execution;
      try {
        execution = await executeProvider(provider, {
          prompt: envelope,
          sessionRef,
          cwd: this.cwd,
          env: this.env,
          runner: this.runner,
          fetchImpl: this.fetchImpl,
        });
      } catch (error) {
        const failureType = classifyProviderFailure(error && error.message ? error.message : String(error));
        const stats = getProviderStats(this.state, provider.id);
        stats.health = failureType;
        stats.lastError = error && error.message ? error.message : String(error);
        lastFailure = {
          providerId: provider.id,
          errorMessage: stats.lastError,
          failureType,
        };
        pendingHandoffFrom = provider;
        pendingHandoffReason = 'failure';
        pendingHandoffErrorMessage = stats.lastError;
        continue;
      }

      if (!execution.ok) {
        const failureType = execution.failureType || classifyProviderFailure(execution.errorMessage || '');
        const stats = getProviderStats(this.state, provider.id);
        stats.health = failureType;
        stats.lastError = execution.errorMessage || `Provider ${provider.id} failed`;
        lastFailure = {
          providerId: provider.id,
          errorMessage: stats.lastError,
          failureType,
        };
        pendingHandoffFrom = provider;
        pendingHandoffReason = 'failure';
        pendingHandoffErrorMessage = stats.lastError;
        continue;
      }

      updateProviderUsage(this.state, provider.id, execution.usage, execution.sessionRef, null);
      appendExchange(this.state, {
        at: new Date().toISOString(),
        userText: prompt,
        assistantText: execution.text || '',
        providerId: provider.id,
        usage: execution.usage,
      });

      const providerLimit = getProviderLimit(this.state, provider.id, provider.budgetTokens || 0);
      const providerUsed = getProviderUsed(this.state, provider.id);
      const providerRatio = providerLimit > 0 ? providerUsed / providerLimit : 0;

      if (pendingHandoffFrom && pendingHandoffFrom.id !== provider.id) {
        recordHandoff(this.state, {
          fromProviderId: pendingHandoffFrom.id,
          toProviderId: provider.id,
          reason: pendingHandoffReason === 'active' ? 'manual' : pendingHandoffReason,
          detail: pendingHandoffReason === 'threshold' ? 'budget handoff' : pendingHandoffReason,
        });
      }

      let nextActiveProviderId = provider.id;
      if (providerRatio >= threshold) {
        const nextProvider = pickFallbackProvider(this.config, this.state, provider.id);
        if (nextProvider) {
          nextActiveProviderId = nextProvider.id;
          if (nextProvider.id !== provider.id) {
            recordHandoff(this.state, {
              fromProviderId: provider.id,
              toProviderId: nextProvider.id,
              reason: 'threshold',
              detail: 'provider crossed the switch threshold',
            });
          }
        }
      }

      this.state.activeProviderId = nextActiveProviderId;
      this.save();

      return {
        ok: true,
        providerId: provider.id,
        text: execution.text || '',
        usage: execution.usage,
        sessionRef: execution.sessionRef || null,
        switchedFrom: pendingHandoffFrom && pendingHandoffFrom.id !== provider.id ? pendingHandoffFrom.id : null,
        switchedTo: nextActiveProviderId !== provider.id ? nextActiveProviderId : null,
        handoffReason:
          pendingHandoffFrom && pendingHandoffFrom.id !== provider.id
            ? pendingHandoffReason === 'active'
              ? 'manual'
              : pendingHandoffReason
            : providerRatio >= threshold && nextActiveProviderId !== provider.id
              ? 'threshold'
              : null,
        snapshotBeforeTurn,
        snapshotAfterTurn: this.snapshot(),
      };
    }

    this.save();
    return {
      ok: false,
      providerId: lastFailure ? lastFailure.providerId : null,
      text: '',
      usage: null,
      errorMessage: lastFailure ? lastFailure.errorMessage : 'No usable provider found in the current configuration',
      failureType: lastFailure ? lastFailure.failureType : 'missing',
      switchedFrom: initialActiveId,
      snapshotBeforeTurn,
      snapshotAfterTurn: this.snapshot(),
    };
  }
}

function createRouter(options) {
  return new Router(options);
}

module.exports = {
  Router,
  buildContextPreview,
  buildHandoffNote,
  buildProviderOrder,
  collectWorkspaceContext,
  createRouter,
  pickFallbackProvider,
};
