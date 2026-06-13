function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function estimateTokens(text) {
  if (!text) {
    return 0;
  }
  const bytes = Buffer.byteLength(String(text), 'utf8');
  return Math.max(1, Math.ceil(bytes / 4));
}

function normalizeClaudeUsage(raw = {}) {
  const promptTokens = toNumber(raw.input_tokens);
  const completionTokens = toNumber(raw.output_tokens);
  const cacheCreationTokens = toNumber(raw.cache_creation_input_tokens);
  const cacheReadTokens = toNumber(raw.cache_read_input_tokens);
  const totalTokens = promptTokens + completionTokens + cacheCreationTokens;

  return {
    promptTokens,
    completionTokens,
    reasoningTokens: 0,
    cachedInputTokens: cacheReadTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens,
    source: 'provider',
    raw,
  };
}

function normalizeCodexUsage(raw = {}) {
  const promptTokens = toNumber(raw.input_tokens);
  const completionTokens = toNumber(raw.output_tokens);
  const reasoningTokens = toNumber(raw.reasoning_output_tokens);
  const cachedInputTokens = toNumber(raw.cached_input_tokens);
  const totalTokens = promptTokens + completionTokens + reasoningTokens;

  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    cachedInputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: cachedInputTokens,
    totalTokens,
    source: 'provider',
    raw,
  };
}

function normalizeGenericUsage(raw = {}, promptText = '', responseText = '') {
  const promptTokens = toNumber(raw.prompt_tokens || raw.input_tokens || estimateTokens(promptText));
  const completionTokens = toNumber(raw.completion_tokens || raw.output_tokens || estimateTokens(responseText));
  const reasoningTokens = toNumber(raw.reasoning_tokens || raw.reasoning_output_tokens);
  const cachedInputTokens = toNumber(raw.cached_input_tokens || raw.cache_read_tokens);
  const cacheCreationTokens = toNumber(raw.cache_creation_input_tokens);
  const cacheReadTokens = toNumber(raw.cache_read_input_tokens);
  const totalTokens = promptTokens + completionTokens + reasoningTokens + cacheCreationTokens;

  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    cachedInputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens,
    source: raw && Object.keys(raw).length > 0 ? 'provider' : 'estimated',
    raw,
  };
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeUsageReport(report = {}, promptText = '', responseText = '') {
  if (report.kind === 'claude') {
    return normalizeClaudeUsage(report.raw);
  }

  if (report.kind === 'codex') {
    return normalizeCodexUsage(report.raw);
  }

  return normalizeGenericUsage(report.raw, promptText, responseText);
}

function parseClaudeOutput(stdout, stderr, exitCode) {
  const parsed = stdout && stdout.trim() ? safeParseJson(stdout.trim()) : null;
  const fallbackText = stdout && stdout.trim() ? stdout.trim() : stderr.trim();

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
  const errorMessage = parsed.is_error ? text || stderr.trim() || 'Claude reported an error' : null;

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

    if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message' && typeof event.item.text === 'string') {
      textParts.push(event.item.text);
    }
  }

  const text = textParts.join('\n').trim() || String(stdout || '').trim();
  const normalizedUsage = normalizeCodexUsage(usage || {});
  const ok = exitCode === 0;

  return {
    ok,
    text,
    sessionRef: threadId ? { threadId } : null,
    usage: usage ? normalizedUsage : normalizeGenericUsage({}, '', text),
    raw: events,
    errorMessage: ok ? null : stderr.trim() || text || `codex exited with code ${exitCode}`,
  };
}

function parseGenericOutput(stdout, stderr, exitCode, promptText = '') {
  const parsed = stdout && stdout.trim() ? safeParseJson(stdout.trim()) : null;
  if (parsed && typeof parsed === 'object') {
    const text = typeof parsed.result === 'string' ? parsed.result : typeof parsed.text === 'string' ? parsed.text : stdout.trim();
    const usageSource = parsed.usage || parsed.usageMetadata || parsed.tokenUsage || {};
    return {
      ok: exitCode === 0,
      text,
      sessionRef: parsed.session_id ? { sessionId: parsed.session_id } : parsed.thread_id ? { threadId: parsed.thread_id } : null,
      usage: normalizeGenericUsage(usageSource, promptText, text),
      raw: parsed,
      errorMessage: exitCode === 0 ? null : stderr.trim() || text || `command exited with code ${exitCode}`,
    };
  }

  const text = stdout.trim() || stderr.trim();
  return {
    ok: exitCode === 0,
    text,
    sessionRef: null,
    usage: normalizeGenericUsage({}, promptText, text),
    raw: text,
    errorMessage: exitCode === 0 ? null : text || `command exited with code ${exitCode}`,
  };
}

function classifyFailure(message = '') {
  const text = String(message).toLowerCase();
  if (text.includes('not logged in') || text.includes('unauthorized') || text.includes('authentication')) {
    return 'auth';
  }
  if (text.includes('enoent') || text.includes('not found') || text.includes('command not found')) {
    return 'missing';
  }
  if (text.includes('operation not permitted') || text.includes('permission denied')) {
    return 'sandbox';
  }
  return 'error';
}

module.exports = {
  classifyFailure,
  estimateTokens,
  normalizeClaudeUsage,
  normalizeCodexUsage,
  normalizeGenericUsage,
  normalizeUsageReport,
  parseClaudeOutput,
  parseCodexOutput,
  parseGenericOutput,
  safeParseJson,
  toNumber,
};

