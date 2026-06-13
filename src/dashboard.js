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
  lines.push('Provider'.padEnd(12) + 'Usage'.padEnd(20) + 'Remaining'.padEnd(14) + 'Health'.padEnd(12) + 'Gauge');
  lines.push('-'.repeat(78));

  for (const provider of snapshot.providerViews) {
    const usage = `${formatNumber(provider.usedTokens)} / ${formatNumber(provider.limitTokens)}`;
    const remaining = formatNumber(provider.remainingTokens);
    const health = provider.health || 'unknown';
    const gauge = renderProgressBar(provider.ratio, 22);
    const prefix = provider.isActive ? '>' : ' ';
    lines.push(
      `${prefix} ${provider.label.padEnd(11)}${usage.padEnd(20)}${remaining.padEnd(14)}${health.padEnd(12)}${gauge} ${formatPercent(provider.ratio)}`
    );
  }

  lines.push('');
  if (snapshot.nextProvider) {
    lines.push(`Next fallback: ${snapshot.nextProvider.label}`);
  }

  if (snapshot.handoffs.length > 0) {
    const last = snapshot.handoffs[snapshot.handoffs.length - 1];
    lines.push(`Last handoff: ${last.fromProviderId} -> ${last.toProviderId} (${last.reason})`);
  }

  return lines.join('\n');
}

function buildDashboardHtml(snapshot) {
  const initialData = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  const refreshMs = snapshot.dashboard.refreshMs || 2000;

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
      max-width: 1440px;
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
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 18px;
    }
    .card {
      position: relative;
      overflow: hidden;
      padding: 20px;
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
    .card-grid {
      display: grid;
      grid-template-columns: 160px 1fr;
      gap: 18px;
      align-items: center;
    }
    .pie {
      --filled: 0deg;
      --accent: #22c55e;
      width: 160px;
      aspect-ratio: 1;
      border-radius: 50%;
      background: conic-gradient(var(--accent) 0 var(--filled), rgba(148, 163, 184, 0.13) var(--filled) 360deg);
      display: grid;
      place-items: center;
      position: relative;
      margin-inline: auto;
      transition: transform 220ms ease;
    }
    .pie::after {
      content: "";
      position: absolute;
      inset: 18px;
      border-radius: 50%;
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
    }
    .pie-label {
      position: relative;
      z-index: 1;
      display: grid;
      place-items: center;
      gap: 4px;
      text-align: center;
    }
    .pie-label .percent {
      font-size: 1.6rem;
      font-weight: 700;
      line-height: 1;
    }
    .pie-label .fraction {
      color: var(--muted);
      font-size: 0.72rem;
      line-height: 1.2;
    }
    .stats {
      display: grid;
      gap: 10px;
    }
    .stat {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      color: var(--muted);
      font-size: 0.9rem;
    }
    .stat strong {
      color: var(--text);
      font-weight: 600;
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
      margin-top: 24px;
      display: grid;
      gap: 16px;
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
    @keyframes rise {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (max-width: 720px) {
      .shell { padding: 16px; }
      .card-grid { grid-template-columns: 1fr; }
      .pie { width: 140px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div>
        <h1 class="title">${APP_NAME}</h1>
        <p class="subtitle">One terminal controller for Claude, Codex, Gemini, and local HTTP-hosted models. The dashboard shows per-model limits, current usage, and the automatic handoff path when a model gets too close to its budget.</p>
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

    <div class="toolbar">
      <span class="pill"><strong id="total-used">0</strong> used</span>
      <span class="pill"><strong id="total-limit">0</strong> budgeted</span>
      <span class="pill">Project: <strong id="project-root">-</strong></span>
      <span class="pill">Refresh every <strong>${Math.round(refreshMs / 1000)}s</strong></span>
    </div>

    <section class="cards" id="cards"></section>

    <section class="feed">
      <div class="feed-card">
        <h2>Handoffs</h2>
        <ul class="handoff-list" id="handoff-list"></ul>
      </div>
      <div class="feed-card">
        <h2>Recent exchanges</h2>
        <ul class="handoff-list" id="exchange-list"></ul>
      </div>
    </section>
  </div>

  <script>
    window.__INITIAL_DATA__ = ${initialData};
    const REFRESH_MS = ${JSON.stringify(refreshMs)};

    function formatNumber(value) {
      return new Intl.NumberFormat('en-US').format(Number.isFinite(value) ? value : 0);
    }

    function formatPercent(ratio) {
      return ((ratio || 0) * 100).toFixed(1) + '%';
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

    function renderProviderCard(provider, index) {
      const percent = Math.max(0, Math.min(100, provider.ratioPercent || 0));
      const angle = Math.round((percent / 100) * 360);
      const activeClass = provider.isActive ? 'active' : '';
      const badge = provider.isActive
        ? '<span class="badge active">active</span>'
        : '<span class="badge">' + escapeHtml(provider.health || 'unknown') + '</span>';
      const descriptor = provider.transport === 'http'
        ? 'HTTP · ' + escapeHtml(provider.target || provider.command || provider.transport)
        : escapeHtml(provider.target || provider.command || provider.model || '');
      const action = provider.isActive
        ? '<button class="primary" disabled>Active</button>'
        : '<button class="primary" data-provider-id="' + escapeHtml(provider.id) + '">Make active</button>';
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
            '<div class="pie" style="--filled:' + angle + 'deg; --accent:' + accentForIndex(index) + '">',
              '<div class="pie-label">',
                '<div class="percent">' + formatPercent(provider.ratio || 0) + '</div>',
                '<div class="fraction">' + formatNumber(provider.usedTokens) + ' / ' + formatNumber(provider.limitTokens) + '</div>',
              '</div>',
            '</div>',
            '<div class="stats">',
              '<div class="stat"><span>Remaining</span><strong>' + formatNumber(provider.remainingTokens) + '</strong></div>',
              '<div class="stat"><span>Health</span><strong>' + escapeHtml(provider.health || 'unknown') + '</strong></div>',
              '<div class="stat"><span>Turns</span><strong>' + formatNumber(provider.totalTurns || 0) + '</strong></div>',
              '<div class="stat"><span>Session</span><strong>' + escapeHtml(provider.lastSessionRef ? JSON.stringify(provider.lastSessionRef) : 'none') + '</strong></div>',
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
      document.getElementById('threshold-value').textContent = formatPercent(snapshot.threshold || 0);
      document.getElementById('total-used').textContent = formatNumber(snapshot.totalUsedTokens);
      document.getElementById('total-limit').textContent = formatNumber(snapshot.totalLimitTokens);
      document.getElementById('project-root').textContent = snapshot.cwd || '-';
      document.getElementById('cards').innerHTML = (snapshot.providerViews || []).map(renderProviderCard).join('');
      document.getElementById('handoff-list').innerHTML = renderHandoffList(snapshot.handoffs || []);
      document.getElementById('exchange-list').innerHTML = renderExchangeList(snapshot.recentExchanges || []);
    }

    async function refresh() {
      const response = await fetch('/api/state', { cache: 'no-store' });
      const snapshot = await response.json();
      render(snapshot);
    }

    document.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-provider-id]');
      if (!button) {
        return;
      }
      button.disabled = true;
      try {
        await fetch('/api/active', {
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
    refresh();
    setInterval(refresh, REFRESH_MS);
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
