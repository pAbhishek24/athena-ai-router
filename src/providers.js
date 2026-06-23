const { URL } = require('url');
const { commandExists, resolveCommand, runCommand } = require('./runner');
const {
  estimateTokens,
  normalizeClaudeUsage,
  normalizeCodexUsage,
  normalizeGenericUsage,
  safeParseJson,
  toNumber,
} = require('./usage');

function getProviderTransport(provider) {
  return String(provider.transport || (provider.http && provider.http.baseUrl ? 'http' : 'command')).trim().toLowerCase() || 'command';
}

function stripProviderFlags(args, flagsToRemove) {
  const removed = new Set(flagsToRemove);
  return (Array.isArray(args) ? args : []).filter((arg) => !removed.has(arg));
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

function compactObject(value) {
  if (Array.isArray(value)) {
    return value.map(compactObject).filter((item) => item !== undefined);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const compacted = compactObject(entry);
      if (compacted && typeof compacted === 'object' && Object.keys(compacted).length === 0) {
        continue;
      }
      result[key] = compacted;
    } else if (Array.isArray(entry)) {
      const compacted = compactObject(entry);
      if (Array.isArray(compacted) && compacted.length === 0) {
        continue;
      }
      result[key] = compacted;
    } else {
      result[key] = entry;
    }
  }

  return result;
}

function getPathValue(root, pathExpression) {
  if (!root || !pathExpression) {
    return undefined;
  }

  const parts = Array.isArray(pathExpression)
    ? pathExpression
    : String(pathExpression)
        .split('.')
        .map((part) => part.trim())
        .filter(Boolean);

  let current = root;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (/^\d+$/.test(part)) {
      current = current[Number(part)];
    } else {
      current = current[part];
    }
  }

  return current;
}

function resolveProviderCommand(provider, env = process.env) {
  const candidates = [];
  if (typeof provider.command === 'string' && provider.command.trim()) {
    candidates.push(provider.command.trim());
  }
  if (Array.isArray(provider.commandCandidates)) {
    candidates.push(...provider.commandCandidates.map((candidate) => String(candidate).trim()).filter(Boolean));
  }
  return resolveCommand(candidates, env);
}

function resolveProviderStatusCommand(provider, env = process.env) {
  const status = provider.status && typeof provider.status === 'object' ? provider.status : {};
  const candidates = [];
  if (typeof status.command === 'string' && status.command.trim()) {
    candidates.push(status.command.trim());
  }
  if (Array.isArray(status.commandCandidates)) {
    candidates.push(...status.commandCandidates.map((candidate) => String(candidate).trim()).filter(Boolean));
  }
  return resolveCommand(candidates, env);
}

function buildCommandInvocation(provider, { prompt, sessionRef } = {}) {
  const command = typeof provider.command === 'string' && provider.command.trim()
    ? provider.command.trim()
    : Array.isArray(provider.commandCandidates) && provider.commandCandidates.length > 0
      ? String(provider.commandCandidates[0]).trim()
      : '';
  const model = typeof provider.model === 'string' ? provider.model.trim() : '';
  const baseArgs = Array.isArray(provider.args) ? provider.args.slice() : [];

  if (provider.id === 'claude') {
    const args = [];
    if (model) {
      args.push('--model', model);
    }
    if (sessionRef && sessionRef.sessionId) {
      args.push('--session-id', sessionRef.sessionId);
    }
    args.push(...stripProviderFlags(baseArgs, ['--model', '--session-id']));
    args.push(prompt);
    return { command, args };
  }

  if (provider.id === 'codex') {
    const args = [];
    if (model) {
      args.push('--model', model);
    }

    args.push('exec');

    const flags = stripProviderFlags(baseArgs, ['exec', 'resume', '--model']);
    const isResume = !!(sessionRef && sessionRef.threadId);

    if (isResume) {
      args.push('resume');
    }

    args.push(...flags);

    if (isResume) {
      args.push(sessionRef.threadId);
    }

    args.push(prompt);
    return { command, args };
  }

  const args = [];
  if (model) {
    args.push('--model', model);
  }
  args.push(...stripProviderFlags(baseArgs, ['--model']));
  args.push(prompt);
  return { command, args };
}

function buildHttpInvocation(provider, { prompt } = {}) {
  const http = provider.http || {};
  const baseUrl = String(http.baseUrl || '').trim();
  const mode = String(http.mode || '').trim().toLowerCase() || 'openai-chat';
  const pathValue = String(http.path || '').trim() || (mode === 'ollama-chat' ? '/api/chat' : '/v1/chat/completions');
  const url = new URL(pathValue, baseUrl).toString();
  const headers = normalizeHeaders(http.headers);
  if (!headers['content-type'] && !headers['Content-Type']) {
    headers['content-type'] = 'application/json';
  }

  const body = buildHttpRequestBody(provider, prompt);
  return {
    transport: 'http',
    url,
    method: String(http.method || 'POST').trim().toUpperCase() || 'POST',
    headers,
    body: JSON.stringify(body),
    timeoutMs: Number.isFinite(http.timeoutMs) && http.timeoutMs > 0 ? http.timeoutMs : 120000,
  };
}

function buildHttpRequestBody(provider, prompt) {
  const http = provider.http || {};
  const mode = String(http.mode || '').trim().toLowerCase() || 'openai-chat';
  const model = typeof provider.model === 'string' ? provider.model.trim() : '';
  const systemPrompt = String(http.systemPrompt || '').trim();
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  messages.push({ role: 'user', content: prompt });

  if (mode === 'ollama-chat') {
    return compactObject({
      model: model || undefined,
      messages,
      stream: false,
      options: compactObject({
        temperature: provider.temperature,
        top_p: provider.topP,
        num_predict: provider.maxTokens,
        ...http.extraBody?.options,
      }),
      ...http.extraBody,
    });
  }

  return compactObject({
    model: model || undefined,
    messages,
    stream: false,
    temperature: provider.temperature,
    max_tokens: provider.maxTokens,
    top_p: provider.topP,
    ...http.extraBody,
  });
}

function buildInvocation(provider, { prompt, sessionRef } = {}) {
  if (getProviderTransport(provider) === 'http') {
    return buildHttpInvocation(provider, { prompt, sessionRef });
  }

  return buildCommandInvocation(provider, { prompt, sessionRef });
}

function normalizeAuthState(value, fallback = 'unknown') {
  const text = String(value || '').trim().toLowerCase();
  if (!text) {
    return fallback;
  }
  if (['ready', 'authenticated', 'connected', 'logged_in', 'logged-in', 'online', 'local'].includes(text)) {
    return text === 'local' ? 'ready' : 'ready';
  }
  if (['auth', 'unauthorized', 'unauthenticated', 'needs-auth', 'needs_auth', 'login-required', 'login_required'].includes(text)) {
    return 'auth';
  }
  if (['missing', 'offline', 'unavailable', 'disabled'].includes(text)) {
    return text;
  }
  return fallback;
}

function extractStatusMetadata(provider, payload, fallbackText = '') {
  const status = provider.status && typeof provider.status === 'object' ? provider.status : {};
  const rawText = String(fallbackText || '').trim();
  const usageSource = getPathValue(payload, status.usagePath) ?? payload?.usage ?? payload?.usageMetadata ?? payload?.tokenUsage ?? null;
  const accountValue =
    getPathValue(payload, status.accountPath) ??
    payload?.account?.name ??
    payload?.account?.email ??
    payload?.user?.name ??
    payload?.user?.email ??
    payload?.identity?.name ??
    payload?.identity?.email ??
    payload?.workspace?.account ??
    payload?.workspace?.user ??
    status.fallbackAccountLabel ??
    '';
  const authValue =
    getPathValue(payload, status.authPath) ??
    payload?.authState ??
    payload?.auth_state ??
    payload?.authenticated ??
    payload?.isAuthenticated ??
    payload?.loginState ??
    payload?.status ??
    '';
  const messageValue =
    getPathValue(payload, status.messagePath) ??
    getPathValue(payload, status.responsePath) ??
    payload?.message ??
    payload?.statusMessage ??
    rawText;

  const accountLabel = String(accountValue || '').trim() || null;
  let authState;
  if (typeof authValue === 'boolean') {
    authState = authValue ? 'ready' : 'auth';
  } else {
    authState = normalizeAuthState(authValue || (rawText ? 'ready' : ''), 'unknown');
  }

  let usage = null;
  if (usageSource && typeof usageSource === 'object') {
    usage = normalizeGenericUsage(usageSource, '', rawText);
  }

  return {
    accountLabel,
    authState,
    statusMessage: String(messageValue || '').trim() || null,
    usage,
  };
}

async function probeProviderStatus(provider, { cwd, env, runner = runCommand, fetchImpl = globalThis.fetch } = {}) {
  const transport = getProviderTransport(provider);
  const now = new Date().toISOString();

  if (transport === 'http') {
    const http = provider.http || {};
    const baseUrl = String(http.baseUrl || '').trim();
    const status = provider.status && typeof provider.status === 'object' ? provider.status : {};
    const pathValue = String(status.path || http.statusPath || '').trim();

    if (!baseUrl) {
      return {
        health: 'missing',
        authState: 'missing',
        accountLabel: null,
        statusMessage: `HTTP provider ${provider.id} is missing http.baseUrl`,
        usage: null,
        lastStatusAt: now,
        raw: null,
      };
    }

    if (!pathValue) {
      return {
        health: 'ready',
        authState: 'ready',
        accountLabel: status.fallbackAccountLabel || provider.label || provider.id,
        statusMessage: 'Local HTTP provider reachable',
        usage: null,
        lastStatusAt: now,
        raw: null,
      };
    }

    if (typeof fetchImpl !== 'function') {
      return {
        health: 'missing',
        authState: 'missing',
        accountLabel: null,
        statusMessage: 'Global fetch is unavailable in this runtime',
        usage: null,
        lastStatusAt: now,
        raw: null,
      };
    }

    try {
      const url = new URL(pathValue, baseUrl).toString();
      const response = await fetchImpl(url, {
        method: String(status.method || 'GET').trim().toUpperCase() || 'GET',
        headers: normalizeHeaders(status.headers || http.headers || {}),
      });
      const responseText = await response.text();
      const parsed = safeParseJson(responseText) || {};
      if (!response.ok) {
        const message = formatProviderErrorMessage(
          provider,
          parsed?.error?.message || parsed?.message || parsed?.error || responseText || `HTTP ${response.status} ${response.statusText}`
        );
        return {
          health: classifyFailure(message, provider),
          authState: normalizeAuthState(message, 'offline'),
          accountLabel: null,
          statusMessage: message,
          usage: null,
          lastStatusAt: now,
          raw: parsed || responseText,
        };
      }

      const metadata = extractStatusMetadata(provider, parsed, responseText);
      return {
        health: metadata.authState === 'auth' ? 'auth' : 'ready',
        authState: metadata.authState,
        accountLabel: metadata.accountLabel,
        statusMessage: metadata.statusMessage,
        usage: metadata.usage,
        lastStatusAt: now,
        raw: parsed,
      };
    } catch (error) {
      const message = formatProviderErrorMessage(provider, error && error.message ? error.message : String(error));
      return {
        health: classifyFailure(message, provider),
        authState: normalizeAuthState(message, 'offline'),
        accountLabel: null,
        statusMessage: message,
        usage: null,
        lastStatusAt: now,
        raw: null,
      };
    }
  }

  const statusCommand = resolveProviderStatusCommand(provider, env);
  const status = provider.status && typeof provider.status === 'object' ? provider.status : {};
  if (!statusCommand || status.enabled === false) {
    if (provider.id === 'gemini') {
      return {
        health: 'disabled',
        authState: 'disabled',
        accountLabel: status.fallbackAccountLabel || provider.label || provider.id,
        statusMessage: getGeminiUnsupportedMessage(),
        usage: null,
        lastStatusAt: now,
        raw: null,
      };
    }

    const command = resolveProviderCommand(provider, env);
    return {
      health: command ? 'ready' : 'missing',
      authState: command ? 'unknown' : 'missing',
      accountLabel: status.fallbackAccountLabel || provider.label || provider.id,
      statusMessage: command ? 'Status probe not configured' : `Command not found: ${provider.commandCandidates && provider.commandCandidates.length ? provider.commandCandidates.join(', ') : provider.command || provider.id}`,
      usage: null,
      lastStatusAt: now,
      raw: null,
    };
  }

  try {
    const invocationArgs = Array.isArray(status.args) ? status.args.slice() : [];
    const rawResult = await runner(statusCommand, invocationArgs, { cwd, env });
    const trimmed = String(rawResult.stdout || '').trim();
    const parsed = trimmed ? safeParseJson(trimmed) : null;
    const payload = parsed && typeof parsed === 'object' ? parsed : { status: trimmed };
    const metadata = extractStatusMetadata(provider, payload, String(rawResult.stderr || '').trim() || trimmed);
    const errorText = String(rawResult.stderr || '').trim();
    const exitHealth = rawResult.code === 0 ? 'ready' : classifyFailure(errorText || trimmed, provider);
    const health = metadata.authState === 'auth' ? 'auth' : exitHealth;
    const statusMessage = formatProviderErrorMessage(provider, metadata.statusMessage || errorText || trimmed);
    return {
      health,
      authState: metadata.authState === 'unknown' && rawResult.code === 0 ? 'ready' : metadata.authState,
      accountLabel: metadata.accountLabel,
      statusMessage,
      usage: metadata.usage,
      lastStatusAt: now,
      raw: parsed || trimmed || rawResult,
    };
  } catch (error) {
    const message = formatProviderErrorMessage(provider, error && error.message ? error.message : String(error));
    return {
      health: classifyFailure(message, provider),
      authState: normalizeAuthState(message, 'error'),
      accountLabel: null,
      statusMessage: message,
      usage: null,
      lastStatusAt: now,
      raw: null,
    };
  }
}

function parseClaudeOutput(stdout, stderr, exitCode) {
  const trimmed = String(stdout || '').trim();
  const parsed = trimmed ? safeParseJson(trimmed) : null;
  const fallbackText = trimmed || String(stderr || '').trim();

  if (!parsed) {
    const text = fallbackText;
    return {
      ok: exitCode === 0,
      text,
      sessionRef: null,
      usage: normalizeGenericUsage({}, text, ''),
      raw: fallbackText,
      errorMessage: exitCode === 0 ? null : fallbackText || `claude exited with code ${exitCode}`,
    };
  }

  const text = typeof parsed.result === 'string' ? parsed.result : '';
  const usage = normalizeClaudeUsage(parsed.usage || {});
  const errorMessage = parsed.is_error ? text || String(stderr || '').trim() || 'Claude reported an error' : null;

  return {
    ok: exitCode === 0 && !parsed.is_error,
    text,
    sessionRef: parsed.session_id ? { sessionId: parsed.session_id } : null,
    usage,
    raw: parsed,
    errorMessage,
  };
}

function parseCodexOutput(stdout, stderr, exitCode) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const events = [];
  let threadId = null;
  let textParts = [];
  let usage = null;

  for (const line of lines) {
    const event = safeParseJson(line);
    if (!event) {
      continue;
    }

    events.push(event);

    if (event.type === 'thread.started' && event.thread_id) {
      threadId = event.thread_id;
    }

    if (event.type === 'turn.completed' && event.usage) {
      usage = event.usage;
    }

    if (event.type === 'item.completed' && event.item && typeof event.item.text === 'string') {
      textParts.push(event.item.text);
    }
  }

  const text = textParts.join('\n').trim() || String(stdout || '').trim();
  const normalizedUsage = usage ? normalizeCodexUsage(usage) : normalizeGenericUsage({}, '', text);
  const errorMessage = exitCode === 0 ? null : String(stderr || '').trim() || text || `codex exited with code ${exitCode}`;

  return {
    ok: exitCode === 0,
    text,
    sessionRef: threadId ? { threadId } : null,
    usage: normalizedUsage,
    raw: events,
    errorMessage,
  };
}

function parseGenericOutput(stdout, stderr, exitCode, promptText = '') {
  const trimmed = String(stdout || '').trim();
  const parsed = trimmed ? safeParseJson(trimmed) : null;

  if (parsed && typeof parsed === 'object') {
    const text = typeof parsed.result === 'string'
      ? parsed.result
      : typeof parsed.text === 'string'
        ? parsed.text
        : trimmed;
    const usageSource = parsed.usage || parsed.usageMetadata || parsed.tokenUsage || {};
    return {
      ok: exitCode === 0,
      text,
      sessionRef: parsed.session_id ? { sessionId: parsed.session_id } : parsed.thread_id ? { threadId: parsed.thread_id } : null,
      usage: normalizeGenericUsage(usageSource, promptText, text),
      raw: parsed,
      errorMessage: exitCode === 0 ? null : String(stderr || '').trim() || text || `command exited with code ${exitCode}`,
    };
  }

  const text = trimmed || String(stderr || '').trim();
  return {
    ok: exitCode === 0,
    text,
    sessionRef: null,
    usage: normalizeGenericUsage({}, promptText, text),
    raw: text,
    errorMessage: exitCode === 0 ? null : text || `command exited with code ${exitCode}`,
  };
}

function normalizeHttpUsage(payload, promptText, responseText) {
  const usage = payload && typeof payload.usage === 'object' ? payload.usage : null;
  if (usage) {
    const promptTokens = toNumber(
      usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_eval_count ?? usage.prompt_eval_tokens
    );
    const completionTokens = toNumber(
      usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.eval_count ?? usage.generated_tokens
    );
    const reasoningTokens = toNumber(usage.reasoning_tokens ?? usage.reasoning_output_tokens ?? usage.reasoningTokens);
    const cachedInputTokens = toNumber(usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cachedInputTokens);
    const cacheCreationTokens = toNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationTokens);
    const cacheReadTokens = toNumber(usage.cache_read_input_tokens ?? usage.cacheReadTokens);
    const totalTokens = promptTokens + completionTokens + reasoningTokens + cacheCreationTokens;

    return {
      promptTokens,
      completionTokens,
      reasoningTokens,
      cachedInputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      totalTokens,
      source: 'provider',
      raw: usage,
    };
  }

  if (Number.isFinite(payload?.prompt_eval_count) || Number.isFinite(payload?.eval_count)) {
    const promptTokens = toNumber(payload.prompt_eval_count);
    const completionTokens = toNumber(payload.eval_count);
    return {
      promptTokens,
      completionTokens,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: promptTokens + completionTokens,
      source: 'provider',
      raw: payload,
    };
  }

  return normalizeGenericUsage({}, promptText, responseText);
}

function parseHttpProviderOutput(provider, { payload, responseText, promptText } = {}) {
  const http = provider.http || {};
  const mode = String(http.mode || '').trim().toLowerCase() || 'openai-chat';
  const textPath = String(http.responsePath || '').trim() || (mode === 'ollama-chat' ? 'message.content' : 'choices.0.message.content');
  const fallbackText = typeof responseText === 'string' ? responseText.trim() : '';
  const text =
    getPathValue(payload, textPath) ??
    (typeof payload?.response === 'string' ? payload.response : undefined) ??
    (typeof payload?.output === 'string' ? payload.output : undefined) ??
    fallbackText;

  const sessionRefValue =
    getPathValue(payload, http.sessionRefPath) ??
    getPathValue(payload, 'id') ??
    getPathValue(payload, 'conversation_id') ??
    getPathValue(payload, 'session_id');

  return {
    ok: true,
    text: typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text),
    sessionRef: sessionRefValue ? { sessionId: String(sessionRefValue) } : null,
    usage: normalizeHttpUsage(payload, promptText, typeof text === 'string' ? text : fallbackText),
    raw: payload,
    errorMessage: null,
  };
}

function parseProviderOutput(provider, { stdout, stderr, exitCode, promptText, payload } = {}) {
  if (getProviderTransport(provider) === 'http') {
    const parsedPayload = payload || (typeof stdout === 'string' ? safeParseJson(stdout.trim()) : null) || {};
    return parseHttpProviderOutput(provider, {
      payload: parsedPayload,
      responseText: typeof stdout === 'string' ? stdout : '',
      promptText,
    });
  }

  if (provider.id === 'claude') {
    return parseClaudeOutput(stdout, stderr, exitCode);
  }

  if (provider.id === 'codex') {
    return parseCodexOutput(stdout, stderr, exitCode);
  }

  return parseGenericOutput(stdout, stderr, exitCode, promptText);
}

function buildHttpError(error, provider) {
  const message = error && error.message ? error.message : String(error);
  return {
    ok: false,
    text: '',
    sessionRef: null,
    usage: null,
    raw: null,
    errorMessage: message,
    failureType: classifyFailure(message, provider),
  };
}

function isGeminiUnsupportedClient(message = '') {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('ineligibletiererror') ||
    text.includes('this client is no longer supported') ||
    text.includes('gemini code assist for individuals') ||
    text.includes('migrate to the antigravity suite') ||
    text.includes('unsupported client')
  );
}

function getGeminiUnsupportedMessage() {
  return 'Gemini CLI is no longer supported for individual accounts. Resolution: switch to Claude, Codex, or a local model, or migrate to Antigravity.';
}

function formatProviderErrorMessage(provider, message = '') {
  const text = String(message || '').trim();
  if (!text) {
    return '';
  }

  if (provider && provider.id === 'gemini' && isGeminiUnsupportedClient(text)) {
    return getGeminiUnsupportedMessage();
  }

  return text;
}

function classifyFailure(message = '', provider = null) {
  const text = String(message).toLowerCase();
  if (provider && provider.id === 'gemini' && isGeminiUnsupportedClient(text)) {
    return 'missing';
  }
  if (text.includes('not logged in') || text.includes('unauthorized') || text.includes('authentication')) {
    return 'auth';
  }
  if (text.includes('enoent') || text.includes('not found') || text.includes('command not found')) {
    return 'missing';
  }
  if (text.includes('operation not permitted') || text.includes('permission denied')) {
    return 'sandbox';
  }
  if (
    text.includes('fetch failed') ||
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('enotfound') ||
    text.includes('network') ||
    text.includes('socket hang up')
  ) {
    return 'offline';
  }
  return 'error';
}

async function executeCommandProvider(provider, { prompt, sessionRef, cwd, env, runner = runCommand } = {}) {
  const command = resolveProviderCommand(provider, env);
  if (!command) {
    const message = `Command not found: ${provider.commandCandidates && provider.commandCandidates.length ? provider.commandCandidates.join(', ') : provider.command || provider.id}`;
    return {
      ok: false,
      text: '',
      sessionRef: null,
      usage: null,
      raw: null,
      errorMessage: message,
      failureType: 'missing',
      transport: 'command',
    };
  }

  const invocation = buildCommandInvocation(provider, { prompt, sessionRef });
  const commandRunner = typeof runner === 'function' ? runner : runCommand;
  const rawResult = await commandRunner(command, invocation.args, { cwd, env });
  const parsed = parseProviderOutput(provider, {
    stdout: rawResult.stdout,
    stderr: rawResult.stderr,
    exitCode: rawResult.code,
    promptText: prompt,
  });

  return {
    ...parsed,
    errorMessage: parsed.errorMessage ? formatProviderErrorMessage(provider, parsed.errorMessage) : null,
    transport: 'command',
    raw: rawResult,
  };
}

async function executeHttpProvider(provider, { prompt, cwd, env, fetchImpl = globalThis.fetch } = {}) {
  const http = provider.http || {};
  if (!http.baseUrl) {
    return {
      ok: false,
      text: '',
      sessionRef: null,
      usage: null,
      raw: null,
      errorMessage: `HTTP provider ${provider.id} is missing http.baseUrl`,
      failureType: 'missing',
      transport: 'http',
    };
  }

  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      text: '',
      sessionRef: null,
      usage: null,
      raw: null,
      errorMessage: 'Global fetch is unavailable in this runtime',
      failureType: 'missing',
      transport: 'http',
    };
  }

  const invocation = buildHttpInvocation(provider, { prompt });
  const headers = { ...invocation.headers };
  const apiKey = http.apiKeyEnv && env ? env[http.apiKeyEnv] : '';
  if (apiKey && !headers.authorization && !headers.Authorization) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeoutMs = invocation.timeoutMs;
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);

  try {
    const response = await fetchImpl(invocation.url, {
      method: invocation.method,
      headers,
      body: invocation.body,
      signal: controller.signal,
    });

    const responseText = await response.text();
    const parsedPayload = safeParseJson(responseText);
    if (!response.ok) {
      const message =
        (parsedPayload && (parsedPayload.error?.message || parsedPayload.message || parsedPayload.error)) ||
        responseText ||
        `HTTP ${response.status} ${response.statusText}`;
      return {
        ok: false,
        text: '',
        sessionRef: null,
        usage: null,
        raw: parsedPayload || responseText,
        errorMessage: message,
        failureType: classifyFailure(message, provider),
        transport: 'http',
      };
    }

    const parsed = parseProviderOutput(provider, {
      payload: parsedPayload || {},
      stdout: responseText,
      promptText: prompt,
    });

    return {
      ...parsed,
      errorMessage: parsed.errorMessage ? formatProviderErrorMessage(provider, parsed.errorMessage) : null,
      transport: 'http',
      raw: parsedPayload || responseText,
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return {
      ok: false,
      text: '',
      sessionRef: null,
      usage: null,
      raw: null,
      errorMessage: formatProviderErrorMessage(provider, message),
      failureType: classifyFailure(message, provider),
      transport: 'http',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function executeProvider(provider, options = {}) {
  if (getProviderTransport(provider) === 'http') {
    return executeHttpProvider(provider, options);
  }

  return executeCommandProvider(provider, options);
}

module.exports = {
  buildCommandInvocation,
  buildHttpInvocation,
  buildHttpRequestBody,
  buildInvocation,
  classifyFailure,
  executeCommandProvider,
  executeHttpProvider,
  executeProvider,
  formatProviderErrorMessage,
  probeProviderStatus,
  getPathValue,
  getProviderTransport,
  normalizeHttpUsage,
  parseClaudeOutput,
  parseCodexOutput,
  parseGenericOutput,
  parseHttpProviderOutput,
  parseProviderOutput,
  resolveProviderCommand,
  resolveProviderStatusCommand,
};
