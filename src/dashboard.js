const http = require('http');
const { URL } = require('url');

const COLORS = ['#f59e0b', '#22c55e', '#06b6d4', '#f97316', '#ef4444', '#84cc16'];
const APP_NAME = 'AI Model Router';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(Number.isFinite(value) ? value : 0);
}

function formatPercent(ratio) {
  return `${(Math.max(0, ratio || 0) * 100).toFixed(1)}%`;
}

function formatUsageSnapshot(usage) {
  if (!usage || typeof usage !== 'object') {
    return 'n/a';
  }

  if (Number.isFinite(usage.totalTokens) && usage.totalTokens > 0) {
    return `${formatNumber(usage.totalTokens)} tokens`;
  }

  const pieces = [];
  if (Number.isFinite(usage.promptTokens)) {
    pieces.push(`prompt ${formatNumber(usage.promptTokens)}`);
  }
  if (Number.isFinite(usage.completionTokens)) {
    pieces.push(`completion ${formatNumber(usage.completionTokens)}`);
  }

  return pieces.length ? pieces.join(', ') : 'n/a';
}

function formatObservedUsageSnapshot(usage) {
  if (!usage || typeof usage !== 'object') {
    return 'n/a';
  }

  const summary = formatUsageSnapshot(usage);
  const parts = [summary];
  if (usage.source) {
    parts.push(String(usage.source));
  }
  if (usage.scope) {
    parts.push(String(usage.scope));
  }
  return parts.join(' · ');
}

function formatSessionRef(sessionRef) {
  if (!sessionRef || typeof sessionRef !== 'object') {
    return 'none';
  }

  if (typeof sessionRef.sessionId === 'string' && sessionRef.sessionId.trim()) {
    return `session ${sessionRef.sessionId.trim().slice(0, 12)}`;
  }
  if (typeof sessionRef.threadId === 'string' && sessionRef.threadId.trim()) {
    return `thread ${sessionRef.threadId.trim().slice(0, 12)}`;
  }

  return JSON.stringify(sessionRef);
}

function formatTimestamp(value) {
  if (!value) {
    return 'n/a';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString();
}

function renderProgressBar(ratio, width = 22) {
  const clamped = Math.max(0, Math.min(1, ratio || 0));
  const filled = Math.round(clamped * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

function renderStatusText(snapshot) {
  const lines = [];
  lines.push(APP_NAME);
  lines.push(`Project: ${snapshot.cwd}`);
  lines.push(`Switch threshold: ${(snapshot.threshold * 100).toFixed(1)}%`);
  lines.push(`Active provider: ${snapshot.activeProvider ? snapshot.activeProvider.label : 'none'}`);
  lines.push(`Dashboard: http://${snapshot.dashboard.host || '127.0.0.1'}:${snapshot.dashboard.port || 3077}`);
  lines.push('');
  lines.push('Global summary');
  lines.push('-'.repeat(72));
  lines.push(`Observed account total: ${formatNumber(snapshot.totalUsedTokens)}`);
  lines.push(`Project ledger: ${formatNumber(snapshot.totalProjectUsedTokens)} / ${formatNumber(snapshot.totalLimitTokens)}`);
  lines.push(`Active provider: ${snapshot.activeProvider ? snapshot.activeProvider.label : 'none'}`);
  lines.push(`Next fallback: ${snapshot.nextProvider ? snapshot.nextProvider.label : 'none'}`);
  lines.push('');
  lines.push('Providers');
  lines.push('-'.repeat(72));

  for (const provider of snapshot.providerViews) {
    const state = provider.stateLabel || (provider.isActive ? 'active' : provider.enabled === false ? 'disabled' : 'inactive');
    const accountUsed = Number.isFinite(provider.effectiveUsedTokens) ? provider.effectiveUsedTokens : provider.usedTokens;
    const projectUsed = Number.isFinite(provider.projectUsedTokens) ? provider.projectUsedTokens : provider.usedTokens;
    const projectUsage = `${formatNumber(projectUsed)} / ${formatNumber(provider.limitTokens)} remaining ${formatNumber(provider.projectRemainingTokens)}`;
    const auth = String(provider.authState || 'unknown');
    const health = provider.health || 'unknown';
    const prefix = provider.isActive ? '>' : ' ';
    lines.push(`${prefix} ${provider.label} [${state}] observed ${formatNumber(accountUsed)} project ${projectUsage} auth ${auth} health ${health}`);
    if (provider.accountLabel) {
      lines.push(`  account: ${provider.accountLabel}`);
    }
    if (provider.statusMessage) {
      lines.push(`  note: ${provider.statusMessage}`);
    }
    const syncParts = [];
    if (provider.lastUsageAt) {
      syncParts.push(`project ${formatTimestamp(provider.lastUsageAt)}`);
    }
    if (provider.observedLastUsageAt) {
      syncParts.push(`observed ${formatTimestamp(provider.observedLastUsageAt)}`);
    }
    if (syncParts.length) {
      lines.push(`  sync: ${syncParts.join(' · ')}`);
    } else {
      lines.push('  sync: n/a');
    }
    if (provider.lastSessionRef) {
      lines.push(`  session: ${formatSessionRef(provider.lastSessionRef)}`);
    }
  }

  if (snapshot.handoffs.length > 0) {
    const last = snapshot.handoffs[snapshot.handoffs.length - 1];
    lines.push(`Last handoff: ${last.fromProviderId} -> ${last.toProviderId} (${last.reason})`);
  }

  return lines.join('\n');
}

function buildDashboardHtml(snapshot) {
  const initialData = JSON.stringify(snapshot).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${APP_NAME}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1020;
      --bg-2: #10182d;
      --panel: rgba(15, 23, 42, 0.88);
      --panel-border: rgba(148, 163, 184, 0.18);
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #22c55e;
      --shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
      --radius: 22px;
      --grid: rgba(148, 163, 184, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "SFMono-Regular", "JetBrains Mono", "IBM Plex Mono", "Menlo", monospace;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(34, 197, 94, 0.16), transparent 28%),
        radial-gradient(circle at 80% 10%, rgba(6, 182, 212, 0.12), transparent 25%),
        linear-gradient(145deg, var(--bg), var(--bg-2));
      overflow-x: hidden;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(to right, var(--grid) 1px, transparent 1px),
        linear-gradient(to bottom, var(--grid) 1px, transparent 1px);
      background-size: 36px 36px;
      mask-image: radial-gradient(circle at center, black 45%, transparent 100%);
      opacity: 0.7;
    }
    .shell {
      position: relative;
      max-width: 1680px;
      margin: 0 auto;
      padding: 28px;
    }
    .hero {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 24px;
      padding: 24px;
      border: 1px solid var(--panel-border);
      border-radius: calc(var(--radius) + 8px);
      background: linear-gradient(180deg, rgba(15, 23, 42, 0.92), rgba(15, 23, 42, 0.72));
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
    }
    .title {
      margin: 0 0 10px;
      font-size: clamp(2rem, 4vw, 3.75rem);
      line-height: 0.95;
      letter-spacing: -0.04em;
    }
    .subtitle {
      margin: 0;
      max-width: 860px;
      color: var(--muted);
      line-height: 1.5;
      font-size: 0.98rem;
    }
    .hero-meta {
      display: grid;
      gap: 10px;
      min-width: 260px;
      padding: 14px 16px;
      border-radius: 18px;
      background: rgba(2, 6, 23, 0.55);
      border: 1px solid rgba(148, 163, 184, 0.16);
    }
    .hero-meta .value {
      font-size: 1.6rem;
      font-weight: 700;
    }
    .hero-meta .label {
      color: var(--muted);
      text-transform: uppercase;
      font-size: 0.72rem;
      letter-spacing: 0.18em;
    }
    .toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      margin-bottom: 24px;
      color: var(--muted);
      font-size: 0.92rem;
    }
    .toolbar .spacer {
      flex: 1 1 auto;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.18);
      background: rgba(15, 23, 42, 0.72);
    }
    .pill strong {
      color: var(--text);
    }
    .summary-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
      padding: 18px;
      border: 1px solid var(--panel-border);
      border-radius: calc(var(--radius) + 4px);
      background: linear-gradient(180deg, rgba(15, 23, 42, 0.88), rgba(15, 23, 42, 0.7));
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
    }
    .summary-card {
      display: grid;
      gap: 6px;
      min-height: 92px;
      padding: 12px 14px;
      border-radius: 18px;
      background: rgba(2, 6, 23, 0.42);
      border: 1px solid rgba(148, 163, 184, 0.14);
      align-content: start;
    }
    .summary-card span {
      color: var(--muted);
      text-transform: uppercase;
      font-size: 0.72rem;
      letter-spacing: 0.18em;
    }
    .summary-card strong {
      font-size: 1.2rem;
      line-height: 1.1;
    }
    .summary-card small {
      color: var(--muted);
      line-height: 1.35;
    }
    .summary-card.compact strong {
      font-size: 1.12rem;
      line-height: 1.25;
      word-break: break-word;
    }
    .summary-actions {
      display: flex;
      align-items: stretch;
      justify-content: stretch;
      min-height: 92px;
    }
    .summary-actions button {
      width: 100%;
      height: 100%;
      border-radius: 18px;
    }
    .section {
      display: grid;
      gap: 14px;
      margin-bottom: 24px;
    }
    .section-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-end;
      flex-wrap: wrap;
    }
    .section-title {
      margin: 0;
      font-size: 1rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .section-note {
      margin: 0;
      color: var(--muted);
      font-size: 0.92rem;
      line-height: 1.45;
      max-width: 820px;
    }
    .cards {
      display: grid;
      gap: 20px;
    }
    .account-cards {
      grid-template-columns: repeat(auto-fit, minmax(600px, 1fr));
    }
    .card {
      position: relative;
      overflow: hidden;
      padding: 18px;
      border-radius: var(--radius);
      background: linear-gradient(180deg, rgba(15, 23, 42, 0.92), rgba(15, 23, 42, 0.76));
      border: 1px solid var(--panel-border);
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
      animation: rise 500ms ease both;
    }
    .card.active {
      border-color: rgba(34, 197, 94, 0.55);
      box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.18), var(--shadow);
    }
    .card-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 16px;
    }
    .name {
      margin: 0;
      font-size: 1.1rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 0.72rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      background: rgba(148, 163, 184, 0.12);
      color: var(--muted);
      border: 1px solid rgba(148, 163, 184, 0.18);
    }
    .badge.active {
      color: #bbf7d0;
      border-color: rgba(34, 197, 94, 0.28);
      background: rgba(34, 197, 94, 0.12);
    }
    .badge.inactive {
      color: #cbd5e1;
      border-color: rgba(148, 163, 184, 0.22);
      background: rgba(148, 163, 184, 0.1);
    }
    .badge.disabled {
      color: #fecaca;
      border-color: rgba(248, 113, 113, 0.22);
      background: rgba(248, 113, 113, 0.1);
    }
    .card-grid {
      display: grid;
      grid-template-columns: 176px minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    .pie {
      --filled: 0deg;
      --accent: #22c55e;
      width: 176px;
      aspect-ratio: 1;
      border-radius: 50%;
      background: conic-gradient(var(--accent) 0 var(--filled), rgba(148, 163, 184, 0.13) var(--filled) 360deg);
      display: grid;
      place-items: center;
      position: relative;
      margin-inline: auto;
      transition: transform 220ms ease;
    }
    .pie.small {
      width: 154px;
    }
    .pie::after {
      content: "";
      position: absolute;
      inset: 22px;
      border-radius: 50%;
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
    }
    .pie.small::after {
      inset: 18px;
    }
    .stats {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
      align-content: start;
    }
    .stat {
      display: flex;
      flex-direction: column;
      gap: 4px;
      color: var(--muted);
      font-size: 0.9rem;
      min-width: 0;
      padding: 8px 10px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(148, 163, 184, 0.1);
    }
    .stat span {
      color: var(--muted);
      font-size: 0.72rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .stat strong {
      color: var(--text);
      font-weight: 600;
      line-height: 1.35;
      word-break: break-word;
    }
    .stat.note strong {
      color: #cbd5e1;
      font-weight: 500;
    }
    .card-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 16px;
    }
    button {
      appearance: none;
      border: 0;
      border-radius: 999px;
      padding: 10px 14px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);
      cursor: pointer;
      font: inherit;
      transition: transform 160ms ease, background 160ms ease;
    }
    button:hover {
      transform: translateY(-1px);
      background: rgba(255, 255, 255, 0.12);
    }
    button.primary {
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.24), rgba(6, 182, 212, 0.18));
      border: 1px solid rgba(34, 197, 94, 0.2);
    }
    .feed {
      margin-top: 20px;
    }
    .feed-card {
      padding: 18px 20px;
      border: 1px solid var(--panel-border);
      border-radius: var(--radius);
      background: rgba(15, 23, 42, 0.82);
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
    }
    .feed-card h2 {
      margin: 0 0 10px;
      font-size: 1rem;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      color: var(--muted);
    }
    .handoff-list {
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .handoff-list li {
      padding: 12px 14px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(148, 163, 184, 0.1);
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
    .handoff-list .reason {
      color: var(--muted);
      font-size: 0.85rem;
    }
    .activity {
      margin-top: 20px;
      padding: 18px 20px;
      border: 1px solid var(--panel-border);
      border-radius: var(--radius);
      background: rgba(15, 23, 42, 0.82);
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
    }
    .activity > summary {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      cursor: pointer;
      list-style: none;
    }
    .activity > summary::-webkit-details-marker {
      display: none;
    }
    .activity-title {
      margin: 0;
      font-size: 1rem;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      color: var(--muted);
    }
    .activity-note {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 0.92rem;
      line-height: 1.45;
    }
    .activity-grid {
      display: grid;
      gap: 16px;
      margin-top: 16px;
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (max-width: 720px) {
      .shell { padding: 16px; }
      .card-grid { grid-template-columns: 1fr; }
      .account-cards,
      .summary-strip { grid-template-columns: 1fr; }
      .pie { width: 160px; }
      .activity > summary { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div>
        <h1 class="title">${APP_NAME}</h1>
        <p class="subtitle">One terminal controller for Claude, Codex, Gemini, and local models. The view keeps the important totals visible without repeating the same account and project numbers in separate sections.</p>
      </div>
      <div class="hero-meta">
        <div>
          <div class="label">Active Provider</div>
          <div class="value" id="active-provider">-</div>
        </div>
        <div>
          <div class="label">Threshold</div>
          <div class="value" id="threshold-value">-</div>
        </div>
      </div>
    </section>

    <section class="summary-strip">
      <div class="summary-card">
        <span>Observed account total</span>
        <strong id="total-used">0</strong>
        <small>Across Claude, Codex, Gemini, and local models</small>
      </div>
      <div class="summary-card">
        <span>Project ledger</span>
        <strong id="project-used">0</strong>
        <small>Current workspace only</small>
      </div>
      <div class="summary-card">
        <span>Router budget</span>
        <strong id="total-limit">0</strong>
        <small>Configured provider budgets</small>
      </div>
      <div class="summary-card">
        <span>Active provider</span>
        <strong id="summary-active-provider">-</strong>
        <small>Current execution target</small>
      </div>
      <div class="summary-card">
        <span>Next fallback</span>
        <strong id="summary-next-provider">none</strong>
        <small>Ready when the active account crosses threshold</small>
      </div>
      <div class="summary-card compact">
        <span>Project</span>
        <strong id="project-root">-</strong>
        <small>Manual refresh only</small>
      </div>
      <div class="summary-actions">
        <button id="refresh-button" class="primary" type="button">Refresh</button>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2 class="section-title">Providers</h2>
          <p class="section-note">One compact card per provider. Account-wide totals and the local router ledger stay on the same card; activity is collapsed below by default.</p>
        </div>
      </div>
      <div class="cards account-cards" id="account-cards"></div>
    </section>

    <details class="activity">
      <summary>
        <div>
          <h2 class="activity-title">Activity</h2>
          <p class="activity-note">Handoffs and recent exchanges are hidden until you need them.</p>
        </div>
        <span class="pill"><strong>Show</strong> details</span>
      </summary>
      <div class="activity-grid">
        <div class="feed-card">
          <h2>Handoffs</h2>
          <ul class="handoff-list" id="handoff-list"></ul>
        </div>
        <div class="feed-card">
          <h2>Recent exchanges</h2>
          <ul class="handoff-list" id="exchange-list"></ul>
        </div>
      </div>
    </details>
  </div>

  <script>
    window.__INITIAL_DATA__ = ${initialData};
    const PROJECT_CWD = ${JSON.stringify(encodeURIComponent(snapshot.cwd || ''))};
    const STATE_URL = PROJECT_CWD ? '/api/state?cwd=' + PROJECT_CWD : '/api/state';
    const ACTIVE_URL = PROJECT_CWD ? '/api/active?cwd=' + PROJECT_CWD : '/api/active';

    function formatNumber(value) {
      return new Intl.NumberFormat('en-US').format(Number.isFinite(value) ? value : 0);
    }

    function formatCompactNumber(value) {
      return new Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(Number.isFinite(value) ? value : 0);
    }

    function formatPercent(ratio) {
      return ((ratio || 0) * 100).toFixed(1) + '%';
    }

    function formatUsageSnapshot(usage, compact = false) {
      if (!usage || typeof usage !== 'object') {
        return 'n/a';
      }

      if (Number.isFinite(usage.totalTokens) && usage.totalTokens > 0) {
        return (compact ? formatCompactNumber(usage.totalTokens) : formatNumber(usage.totalTokens)) + ' tokens';
      }

      const pieces = [];
      if (Number.isFinite(usage.promptTokens)) {
        pieces.push('prompt ' + formatNumber(usage.promptTokens));
      }
      if (Number.isFinite(usage.completionTokens)) {
        pieces.push('completion ' + formatNumber(usage.completionTokens));
      }
      return pieces.length ? pieces.join(', ') : 'n/a';
    }

    function formatObservedUsageSnapshot(usage, compact = false) {
      if (!usage || typeof usage !== 'object') {
        return 'n/a';
      }

      const summary = formatUsageSnapshot(usage, compact);
      const parts = [summary];
      if (usage.source) {
        parts.push(String(usage.source));
      }
      if (usage.scope) {
        parts.push(String(usage.scope));
      }
      return parts.join(' · ');
    }

    function formatSessionRef(sessionRef) {
      if (!sessionRef || typeof sessionRef !== 'object') {
        return 'none';
      }

      if (typeof sessionRef.sessionId === 'string' && sessionRef.sessionId.trim()) {
        return 'session ' + sessionRef.sessionId.trim().slice(0, 12);
      }
      if (typeof sessionRef.threadId === 'string' && sessionRef.threadId.trim()) {
        return 'thread ' + sessionRef.threadId.trim().slice(0, 12);
      }

      return JSON.stringify(sessionRef);
    }

    function formatTimestamp(value) {
      if (!value) {
        return 'n/a';
      }

      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return String(value);
      }

      return date.toLocaleString();
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function accentForIndex(index) {
      return ${JSON.stringify(COLORS)}[index % ${COLORS.length}];
    }

    function renderAccountCard(provider, index) {
      const angle = Math.round((Math.max(0, Math.min(100, provider.projectRatioPercent || 0)) / 100) * 360);
      const stateLabel = provider.stateLabel || (provider.isActive ? 'active' : provider.enabled === false ? 'disabled' : 'inactive');
      const activeClass = provider.isActive ? 'active' : '';
      const badgeClass = stateLabel === 'active' ? 'active' : stateLabel === 'disabled' ? 'disabled' : 'inactive';
      const badge = '<span class="badge ' + badgeClass + '">' + escapeHtml(stateLabel) + '</span>';
      const descriptor = provider.transport === 'http'
        ? 'HTTP · ' + escapeHtml(provider.target || provider.command || provider.transport)
        : escapeHtml(provider.target || provider.command || provider.model || '');
      const accountUsed = Number.isFinite(provider.effectiveUsedTokens) ? provider.effectiveUsedTokens : Number.isFinite(provider.usedTokens) ? provider.usedTokens : 0;
      const projectUsed = Number.isFinite(provider.projectUsedTokens) ? provider.projectUsedTokens : Number.isFinite(provider.usedTokens) ? provider.usedTokens : 0;
      const accountLabelValue = provider.accountLabel ? String(provider.accountLabel) : 'n/a';
      const syncValue = formatTimestamp(provider.lastUsageAt || provider.observedLastUsageAt);
      const action = provider.isActive
        ? '<button class="primary" disabled>Active</button>'
        : '<button class="primary" data-provider-id="' + escapeHtml(provider.id) + '">Make active</button>';
      const usageTitle =
        'Account ' +
        formatCompactNumber(accountUsed) +
        ' · project ledger ' +
        formatCompactNumber(projectUsed) +
        ' · budget ' +
        formatCompactNumber(provider.limitTokens);
      const usageValue = 'Account ' + formatCompactNumber(accountUsed) + ' · project ' + formatCompactNumber(projectUsed);
      return [
        '<article class="card ' + activeClass + '" style="--accent:' + accentForIndex(index) + '">',
          '<div class="card-head">',
            '<div>',
              '<h3 class="name">' + escapeHtml(provider.label) + '</h3>',
              '<div style="color: var(--muted); font-size: 0.82rem; margin-top: 6px;">' + descriptor + (provider.model ? ' · ' + escapeHtml(provider.model) : '') + '</div>',
            '</div>',
            badge,
          '</div>',
          '<div class="card-grid">',
            '<div class="pie" aria-label="' + escapeHtml(usageTitle) + '" title="' + escapeHtml(usageTitle) + '" style="--filled:' + angle + 'deg; --accent:' + accentForIndex(index) + '"></div>',
            '<div class="stats">',
              '<div class="stat"><span>State</span><strong title="' + escapeHtml(stateLabel) + '">' + escapeHtml(stateLabel) + '</strong></div>',
              '<div class="stat"><span>Account</span><strong title="' + escapeHtml(accountLabelValue) + '">' + escapeHtml(accountLabelValue) + '</strong></div>',
              '<div class="stat"><span>Usage</span><strong title="' + escapeHtml(usageTitle) + '">' + escapeHtml(usageValue) + '</strong></div>',
              '<div class="stat"><span>Auth / Health</span><strong title="' + escapeHtml((provider.authState || 'unknown') + ' / ' + (provider.health || 'unknown')) + '">' + escapeHtml((provider.authState || 'unknown') + ' / ' + (provider.health || 'unknown')) + '</strong></div>',
              '<div class="stat"><span>Sync</span><strong title="' + escapeHtml(syncValue) + '">' + escapeHtml(syncValue) + '</strong></div>',
              provider.statusMessage ? '<div class="stat note"><span>Note</span><strong title="' + escapeHtml(provider.statusMessage) + '">' + escapeHtml(provider.statusMessage) + '</strong></div>' : '',
            '</div>',
          '</div>',
          '<div class="card-actions">' + action + '</div>',
          provider.lastError ? '<div style="margin-top:12px; color:#fca5a5; font-size:0.84rem;">Last error: ' + escapeHtml(provider.lastError) + '</div>' : '',
        '</article>',
      ].join('');
    }

    function renderHandoffList(items) {
      if (!items || !items.length) {
        return '<li><span>No handoffs yet.</span><span class="reason">The router will record switches here.</span></li>';
      }
      return items.slice().reverse().map((item) => {
        return '<li><span>' + escapeHtml(item.fromProviderId) + ' → ' + escapeHtml(item.toProviderId) + '</span><span class="reason">' + escapeHtml(item.reason || 'handoff') + '</span></li>';
      }).join('');
    }

    function renderExchangeList(items) {
      if (!items || !items.length) {
        return '<li><span>No exchanges yet.</span><span class="reason">Start chatting from the terminal.</span></li>';
      }
      return items.slice(-6).reverse().map((item) => {
        return '<li><span>' + escapeHtml(item.providerId || 'unknown') + ': ' + escapeHtml((item.userText || '').slice(0, 90)) + '</span><span class="reason">' + escapeHtml((item.assistantText || '').slice(0, 90)) + '</span></li>';
      }).join('');
    }

function render(snapshot) {
      document.getElementById('active-provider').textContent = snapshot.activeProvider ? snapshot.activeProvider.label : '-';
      document.getElementById('summary-active-provider').textContent = snapshot.activeProvider ? snapshot.activeProvider.label : '-';
      document.getElementById('summary-next-provider').textContent = snapshot.nextProvider ? snapshot.nextProvider.label : 'none';
      document.getElementById('threshold-value').textContent = formatPercent(snapshot.threshold || 0);
      document.getElementById('total-used').textContent = formatNumber(snapshot.totalUsedTokens);
      const projectUsed = Number.isFinite(snapshot.totalProjectUsedTokens) ? snapshot.totalProjectUsedTokens : 0;
      document.getElementById('project-used').textContent = formatNumber(projectUsed);
      document.getElementById('total-limit').textContent = formatNumber(snapshot.totalLimitTokens);
      document.getElementById('project-root').textContent = snapshot.cwd || '-';
      document.getElementById('account-cards').innerHTML = (snapshot.providerViews || []).map(renderAccountCard).join('');
      document.getElementById('handoff-list').innerHTML = renderHandoffList(snapshot.handoffs || []);
      document.getElementById('exchange-list').innerHTML = renderExchangeList(snapshot.recentExchanges || []);
    }

    async function refresh() {
      const response = await fetch(STATE_URL, { cache: 'no-store' });
      const snapshot = await response.json();
      render(snapshot);
    }

    document.getElementById('refresh-button').addEventListener('click', () => {
      refresh();
    });

    document.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-provider-id]');
      if (!button) {
        return;
      }
      button.disabled = true;
      try {
        await fetch(ACTIVE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId: button.dataset.providerId }),
        });
        await refresh();
      } finally {
        button.disabled = false;
      }
    });

    render(window.__INITIAL_DATA__);
  </script>
</body>
</html>`;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function createDashboardHandler(router) {
  return async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, router.snapshot());
      return;
    }

    if (url.pathname === '/api/active' && req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        if (!body || typeof body.providerId !== 'string' || !body.providerId.trim()) {
          sendJson(res, 400, { ok: false, error: 'providerId is required' });
          return;
        }
        const ok = router.setActiveProvider(body.providerId.trim(), 'dashboard');
        if (!ok) {
          sendJson(res, 404, { ok: false, error: `Unknown provider ${body.providerId}` });
          return;
        }
        sendJson(res, 200, { ok: true, activeProviderId: body.providerId.trim() });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message || String(error) });
      }
      return;
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    const snapshot = router.snapshot();
    const html = buildDashboardHtml(snapshot);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(html);
  };
}

function createDashboardServer(router, options = {}) {
  const host = options.host || router.config.dashboard.host || '127.0.0.1';
  const port = Number.isFinite(options.port) ? options.port : router.config.dashboard.port || 3077;
  const server = http.createServer(createDashboardHandler(router));

  return {
    host,
    port,
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          const resolvedPort = address && typeof address === 'object' ? address.port : port;
          resolve({
            host,
            port: resolvedPort,
            url: `http://${host}:${resolvedPort}`,
          });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = {
  buildDashboardHtml,
  createDashboardServer,
  createDashboardHandler,
  renderStatusText,
};
