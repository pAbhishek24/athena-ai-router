const fs = require('fs');
const path = require('path');
const defaultConfig = require('../config/router.config.example.json');
const { ensureRouterStructure, getConfigPath } = require('./paths');

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeHeaders(headers) {
  const result = {};
  if (!headers || typeof headers !== 'object') {
    return result;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) {
      result[key] = String(value);
    }
  }

  return result;
}

function normalizeHttpConfig(provider) {
  const http = provider.http && typeof provider.http === 'object' ? provider.http : {};
  const baseUrl = String(http.baseUrl || provider.baseUrl || '').trim();
  const mode = String(http.mode || provider.httpMode || '').trim() || (baseUrl.includes('/api/') ? 'ollama-chat' : 'openai-chat');
  const pathDefault = mode === 'ollama-chat' ? '/api/chat' : '/v1/chat/completions';
  const pathValue = String(http.path || provider.path || provider.endpoint || pathDefault || '').trim() || pathDefault;
  const method = String(http.method || provider.method || 'POST').trim().toUpperCase() || 'POST';

  return {
    baseUrl,
    path: pathValue,
    method,
    mode,
    headers: normalizeHeaders(http.headers || provider.headers || {}),
    timeoutMs: Number.isFinite(http.timeoutMs || provider.timeoutMs) ? Number(http.timeoutMs || provider.timeoutMs) : 120000,
    apiKeyEnv: String(http.apiKeyEnv || provider.apiKeyEnv || '').trim(),
    systemPrompt: String(http.systemPrompt || provider.systemPrompt || '').trim(),
    responsePath: String(http.responsePath || provider.responsePath || '').trim(),
    usagePath: String(http.usagePath || provider.usagePath || '').trim(),
    sessionRefPath: String(http.sessionRefPath || provider.sessionRefPath || '').trim(),
    extraBody: http.extraBody && typeof http.extraBody === 'object' ? deepClone(http.extraBody) : provider.extraBody && typeof provider.extraBody === 'object' ? deepClone(provider.extraBody) : {},
  };
}

function normalizeCommandCandidates(provider) {
  const rawCandidates = Array.isArray(provider.commandCandidates)
    ? provider.commandCandidates
    : provider.command
      ? [provider.command]
      : [];

  return rawCandidates.map((candidate) => String(candidate).trim()).filter(Boolean);
}

function mergeObject(base, override) {
  if (Array.isArray(base)) {
    return Array.isArray(override) ? override.slice() : base.slice();
  }

  if (base && typeof base === 'object') {
    const result = { ...base };
    if (override && typeof override === 'object' && !Array.isArray(override)) {
      for (const [key, value] of Object.entries(override)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && base[key]) {
          result[key] = mergeObject(base[key], value);
        } else {
          result[key] = Array.isArray(value) ? value.slice() : value;
        }
      }
    }
    return result;
  }

  return override === undefined ? base : override;
}

function normalizeProvider(provider, index) {
  if (!provider || typeof provider !== 'object') {
    throw new Error(`Invalid provider at index ${index}`);
  }

  if (!provider.id || typeof provider.id !== 'string') {
    throw new Error(`Provider at index ${index} is missing an id`);
  }

  const transport = String(provider.transport || (provider.http || provider.baseUrl ? 'http' : 'command')).trim().toLowerCase() || 'command';
  const commandCandidates = normalizeCommandCandidates(provider);
  const command = provider.command && typeof provider.command === 'string' ? provider.command.trim() : commandCandidates[0] || '';

  if (transport !== 'http' && !command && commandCandidates.length === 0) {
    throw new Error(`Provider ${provider.id} is missing a command or commandCandidates entry`);
  }

  return {
    id: provider.id,
    label: provider.label || provider.id,
    transport,
    command,
    commandCandidates,
    args: Array.isArray(provider.args) ? provider.args.slice() : [],
    budgetTokens: Number.isFinite(provider.budgetTokens) ? provider.budgetTokens : defaultConfig.providers[index]?.budgetTokens || 0,
    model: typeof provider.model === 'string' ? provider.model : '',
    enabled: provider.enabled !== false,
    temperature: Number.isFinite(provider.temperature) ? provider.temperature : undefined,
    maxTokens: Number.isFinite(provider.maxTokens) ? provider.maxTokens : undefined,
    topP: Number.isFinite(provider.topP) ? provider.topP : undefined,
    http: normalizeHttpConfig(provider),
  };
}

function normalizeConfig(rawConfig = {}) {
  const merged = mergeObject(deepClone(defaultConfig), rawConfig);
  merged.providers = Array.isArray(merged.providers) ? merged.providers.map(normalizeProvider) : [];
  if (!merged.defaultProviderId && merged.providers.length > 0) {
    merged.defaultProviderId = merged.providers[0].id;
  }
  if (!merged.switchThreshold || !Number.isFinite(merged.switchThreshold)) {
    merged.switchThreshold = defaultConfig.switchThreshold;
  }
  merged.dashboard = mergeObject(defaultConfig.dashboard, merged.dashboard || {});
  return merged;
}

function loadConfig(env = process.env, options = {}) {
  const configPath = options.configPath || env.ATHENA_ROUTER_CONFIG || getConfigPath(env);
  let raw = {};

  if (fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  return {
    config: normalizeConfig(raw),
    configPath,
    exists: fs.existsSync(configPath),
  };
}

function saveConfig(config, env = process.env, options = {}) {
  const configPath = options.configPath || env.ATHENA_ROUTER_CONFIG || getConfigPath(env);
  ensureRouterStructure(env);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

function initializeConfig(env = process.env, options = {}) {
  const { config, configPath, exists } = loadConfig(env, options);
  if (!exists || options.force) {
    saveConfig(config, env, { configPath });
  }
  return { config, configPath, created: !exists };
}

module.exports = {
  initializeConfig,
  loadConfig,
  normalizeConfig,
  saveConfig,
};
