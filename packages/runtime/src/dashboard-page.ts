function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function buildDashboardPage(): string {
  const styles = `
    :root {
      color-scheme: light;
      --bg: #f5f5f7;
      --surface: #ffffff;
      --surface-soft: #fbfbfd;
      --surface-tint: #f7faf8;
      --border: #dad7cd;
      --border-strong: #c9c5ba;
      --text: #1d1d1f;
      --muted: #6e6e73;
      --faint: #9a9aa0;
      --green: #588157;
      --green-soft: #eef3eb;
      --blue: #0a66c2;
      --blue-soft: #f2f7ff;
      --amber: #946200;
      --amber-soft: #faedcd;
      --red: #b3261e;
      --red-soft: #fff2f1;
      --slate-soft: #dad7cd;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.035), 0 12px 34px rgba(0, 0, 0, 0.035);
      --radius: 8px;
    }

    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      min-height: 100%;
      overflow-x: hidden;
      color: var(--text);
      background: var(--bg);
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    }
    body { padding: 22px; }

    .shell {
      display: grid;
      gap: 16px;
      width: 100%;
      max-width: 1660px;
      margin: 0 auto;
      min-width: 0;
    }
    .topbar, .hero, .metric, .panel, .agent-card, .task-card, .event-row, .artifact-row, .health-row, .focus-card, .diagnostic-row {
      background: rgba(255, 255, 255, 0.86);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }

    .topbar {
      min-height: 58px;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      min-width: 0;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .brand > div:not(.brand-mark) {
      min-width: 0;
    }
    .brand-mark {
      width: 32px;
      height: 32px;
      border-radius: 7px;
      display: grid;
      place-items: center;
      color: #fff;
      background: linear-gradient(180deg, #343437, #1d1d1f);
      font-weight: 800;
    }
    .brand h1 {
      margin: 0;
      font-size: 1.04rem;
      font-weight: 760;
      overflow-wrap: anywhere;
    }
    .brand p, .subtle, .panel-subtitle {
      margin: 3px 0 0;
      color: var(--muted);
      font-size: 0.88rem;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .top-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
      min-width: 0;
      max-width: 100%;
    }
    .topbar > * {
      min-width: 0;
      max-width: 100%;
    }

    .hero {
      padding: 20px;
      display: grid;
      grid-template-columns: minmax(0, 1.45fr) minmax(420px, 0.95fr);
      gap: 18px;
      align-items: stretch;
      min-width: 0;
      background: rgba(255, 255, 255, 0.9);
    }
    .hero h2 {
      margin: 6px 0 8px;
      font-size: clamp(1.55rem, 2.2vw, 2.35rem);
      line-height: 1.08;
      font-weight: 780;
      overflow-wrap: anywhere;
    }
    .eyebrow {
      color: #4b4b50;
      font-size: 0.78rem;
      font-weight: 760;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .mission {
      max-width: 980px;
      color: #3a3a3c;
      font-size: 1rem;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .hero-meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    .run-strip {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .run-fact {
      min-height: 78px;
      padding: 12px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.68);
    }
    .fact-label, .metric-label {
      color: var(--muted);
      font-size: 0.78rem;
      font-weight: 720;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .fact-value {
      margin-top: 8px;
      font-weight: 760;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .run-fact.wide {
      grid-column: 1 / -1;
    }
    .fact-value.wrap {
      white-space: normal;
      overflow-wrap: anywhere;
      line-height: 1.28;
    }

    .pill, .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 28px;
      padding: 5px 9px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.72);
      color: var(--muted);
      font-size: 0.82rem;
      font-weight: 720;
      white-space: nowrap;
      max-width: 100%;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: currentColor;
    }
    .is-live .status-dot {
      box-shadow: 0 0 0 4px rgba(88, 129, 87, 0.12);
      animation: breathe 2.4s ease-in-out infinite;
    }
    .status-running, .status-active, .status-assigned, .status-in_progress, .status-ok, .status-healthy {
      color: var(--green);
      background: var(--green-soft);
      border-color: #dad7cd;
    }
    .status-idle, .status-pending, .status-waiting {
      color: var(--blue);
      background: var(--blue-soft);
      border-color: #dad7cd;
    }
    .status-blocked {
      color: var(--amber);
      background: var(--amber-soft);
      border-color: #faedcd;
    }
    .status-done, .status-completed, .status-abandoned {
      color: #536372;
      background: var(--slate-soft);
      border-color: #dad7cd;
    }
    .status-error, .status-stopped {
      color: var(--red);
      background: var(--red-soft);
      border-color: #f1d3d0;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 12px;
    }
    .metric {
      min-height: 112px;
      padding: 15px;
      display: grid;
      align-content: space-between;
      box-shadow: none;
    }
    .metric-value {
      margin-top: 10px;
      font-size: 2rem;
      line-height: 1;
      font-weight: 790;
    }
    .metric-sub {
      color: var(--muted);
      font-size: 0.86rem;
      line-height: 1.35;
    }
    .metric.active,
    .metric.pending,
    .metric.blocked,
    .metric.done,
    .metric.output,
    .metric.health {
      border-left: 1px solid var(--border);
    }

    .focus-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 12px;
    }
    .focus-card {
      box-shadow: none;
      padding: 14px;
      display: grid;
      gap: 10px;
      border-left: 2px solid #d4ded8;
    }
    .focus-title {
      margin: 0;
      font-size: 1.08rem;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .detail-item {
      min-width: 0;
      padding: 9px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface-soft);
    }
    .detail-item.full { grid-column: 1 / -1; }
    .detail-label {
      color: var(--muted);
      font-size: 0.74rem;
      font-weight: 760;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .detail-value {
      margin-top: 5px;
      overflow-wrap: anywhere;
      line-height: 1.32;
    }
    .content-grid {
      display: grid;
      gap: 16px;
      align-items: stretch;
    }
    .dashboard-pair {
      display: flex;
      gap: 16px;
      align-items: flex-start;
      min-width: 0;
    }
    .dashboard-pair > .panel {
      min-width: 0;
      align-self: flex-start;
    }
    .pair-focus {
      align-items: stretch;
    }
    .pair-focus > .panel {
      align-self: stretch;
      height: 420px;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .pair-focus .focus-grid {
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      align-items: start;
      padding-right: 2px;
      overscroll-behavior: contain;
    }
    .pair-focus .focus-card {
      align-self: start;
    }
    .pair-focus .events {
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      max-height: none;
      overscroll-behavior: contain;
    }
    .pair-agents {
      align-items: stretch;
    }
    .pair-agents > .panel {
      align-self: stretch;
      height: 520px;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .pair-agents .agents-grid,
    .pair-agents .capsules-list {
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      max-height: none;
      overscroll-behavior: contain;
      padding-right: 2px;
    }
    .pair-diagnostics {
      align-items: stretch;
    }
    .pair-diagnostics > .panel {
      align-self: stretch;
      height: 496px;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .pair-diagnostics .health-scroll,
    .pair-diagnostics .artifacts {
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      max-height: none;
      overscroll-behavior: contain;
    }
    .pair-diagnostics .health-panel {
      grid-template-rows: auto minmax(0, 1fr);
    }
    .health-scroll {
      display: grid;
      align-content: start;
      gap: 10px;
      padding-right: 2px;
    }
    .health-scroll .health-list,
    .health-scroll .diagnostics-list {
      max-height: none;
      overflow: visible;
      padding-right: 0;
    }
    .dashboard-pair > .panel:first-child {
      flex: 1.62 1 0;
    }
    .dashboard-pair > .panel:last-child {
      flex: 0.9 1 360px;
    }
    .section {
      display: grid;
      gap: 16px;
      min-width: 0;
      align-content: start;
    }
    .focus-panel,
    .events-panel,
    .agents-panel,
    .capsules-panel,
    .task-board-panel,
    .health-panel,
    .outputs-panel {
      min-width: 0;
    }
    .panel {
      padding: 16px;
      min-width: 0;
      box-shadow: none;
    }
    .panel-header {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      align-items: start;
      margin-bottom: 14px;
    }
    .panel h3 {
      margin: 0;
      font-size: 1.02rem;
    }

    .agents-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .agent-card {
      padding: 12px;
      box-shadow: none;
      display: grid;
      gap: 9px;
      border-top: 2px solid var(--border-strong);
      align-content: start;
      min-height: 132px;
    }
    .agent-card.is-running { border-top-color: #588157; }
    .agent-card.is-idle { border-top-color: #cfdced; }
    .agent-card.is-error { border-top-color: #edc9c5; }
    .agent-name {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .agent-name strong { overflow-wrap: anywhere; }
    .task-lanes {
      display: grid;
      grid-template-columns:
        minmax(190px, 0.95fr)
        minmax(180px, 0.78fr)
        minmax(180px, 0.78fr)
        minmax(280px, 1.35fr);
      gap: 12px;
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }
    .task-lane {
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      align-content: start;
      gap: 10px;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface-soft);
    }
    .task-lane-scroll {
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      scrollbar-gutter: stable;
      display: grid;
      align-content: start;
      grid-auto-rows: max-content;
      gap: 10px;
      padding-right: 2px;
      overscroll-behavior: contain;
    }
    .task-board-panel {
      height: clamp(460px, 56vh, 680px);
      min-height: 0;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .lane-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      color: var(--muted);
      font-size: 0.82rem;
      font-weight: 760;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .task-card {
      padding: 12px;
      box-shadow: none;
      background: var(--surface);
      display: grid;
      gap: 9px;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
    }
    .task-card strong {
      line-height: 1.28;
      overflow-wrap: anywhere;
      min-width: 0;
    }
    .task-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
      max-width: 100%;
    }
    .task-meta .pill {
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-word;
      line-height: 1.25;
    }
    .task-result {
      color: var(--muted);
      font-size: 0.86rem;
      line-height: 1.35;
      overflow-wrap: anywhere;
      word-break: break-word;
      min-width: 0;
    }
    .empty {
      color: var(--faint);
      font-size: 0.9rem;
      line-height: 1.45;
      padding: 12px;
      border: 1px dashed var(--border-strong);
      border-radius: var(--radius);
      background: rgba(255,255,255,0.55);
    }

    .events, .artifacts, .health-list, .capsules-list, .diagnostics-list {
      display: grid;
      gap: 9px;
      max-height: 430px;
      overflow: auto;
      padding-right: 2px;
    }
    .diagnostics-list {
      margin-top: 10px;
    }
    .event-row, .artifact-row, .health-row, .diagnostic-row {
      box-shadow: none;
      padding: 11px;
    }
    .event-row {
      display: grid;
      grid-template-columns: 72px minmax(0, 1fr);
      gap: 10px;
      border-left: 3px solid var(--border-strong);
    }
    .event-row.is-agent-process { border-left-color: #588157; }
    .event-row.is-supervisor { border-left-color: #ccd8e8; }
    .event-time {
      color: var(--faint);
      font-size: 0.78rem;
      padding-top: 2px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow-wrap: normal;
      word-break: normal;
    }
    .event-main { display: grid; gap: 5px; min-width: 0; }
    .event-title {
      display: flex;
      gap: 7px;
      align-items: center;
      flex-wrap: wrap;
      font-weight: 760;
    }
    .event-detail, .artifact-detail {
      color: var(--muted);
      font-size: 0.86rem;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }

    .artifact-row, .health-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .artifact-title { font-weight: 750; }
    .capsule-row {
      display: grid;
      gap: 7px;
      padding: 11px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface);
    }
    .capsule-row.is-open { border-left: 2px solid #588157; }
    .capsule-row.is-in_review { border-left: 2px solid #ccd8e8; }
    .capsule-row.is-blocked { border-left: 2px solid #faedcd; }
    .capsule-row.is-abandoned { opacity: 0.72; }
    .capsule-title {
      font-weight: 760;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .diagnostic-row {
      display: grid;
      gap: 6px;
      border-left: 2px solid var(--border-strong);
    }
    .diagnostic-row.warn { border-left-color: #faedcd; }
    .diagnostic-row.fail { border-left-color: #edc9c5; }
    .mono {
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 0.86rem;
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .event-time.mono {
      white-space: nowrap;
      overflow-wrap: normal;
      word-break: normal;
    }
    .timestamp {
      color: var(--muted);
      font-size: 0.84rem;
      text-align: right;
    }

    @media (max-width: 1380px) {
      .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .agents-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .task-lanes { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .dashboard-pair { flex-direction: column; }
      .dashboard-pair > .panel:first-child,
      .dashboard-pair > .panel:last-child {
        flex: 1 1 auto;
      }
      .pair-focus > .panel {
        height: clamp(360px, 54vh, 560px);
      }
      .pair-agents > .panel {
        height: min(560px, 62vh);
      }
      .pair-diagnostics > .panel {
        height: 496px;
      }
      .task-board-panel {
        height: clamp(560px, 64vh, 760px);
        overflow: hidden;
        display: grid;
      }
      .task-lanes {
        height: 100%;
        overflow: auto;
      }
      .task-lane { height: auto; }
    }
    @media (max-width: 920px) {
      body { padding: 12px; }
      .topbar {
        display: grid;
        grid-template-columns: 1fr;
        align-items: stretch;
      }
      .hero { grid-template-columns: 1fr; }
      .hero { display: grid; }
      .hero > *,
      .brand,
      .brand > div:not(.brand-mark) {
        min-width: 0;
        max-width: 100%;
      }
      .brand > div:not(.brand-mark) {
        flex: 1 1 0;
      }
      .brand {
        align-items: flex-start;
        width: 100%;
      }
      .brand h1,
      .brand p,
      .hero h2,
      .mission {
        max-width: 100%;
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .run-strip { grid-template-columns: 1fr; }
      .metrics, .task-lanes { grid-template-columns: 1fr; }
      .agents-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .focus-grid, .detail-grid { grid-template-columns: 1fr; }
      .pair-focus > .panel {
        height: min(560px, 62vh);
      }
      .pair-agents > .panel {
        height: min(560px, 62vh);
      }
      .pair-diagnostics > .panel {
        height: min(560px, 62vh);
      }
      .task-board-panel { height: min(720px, 78vh); }
      .task-lanes {
        overflow-y: auto;
      }
      .task-lane { height: auto; min-height: 280px; }
      .topbar, .panel-header { align-items: stretch; flex-direction: column; }
      .top-actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, max-content));
        justify-content: flex-start;
        align-items: start;
        width: 100%;
        flex: 1 1 100%;
      }
      .top-actions .pill,
      .top-actions .status-badge,
      .hero-meta .pill {
        min-width: 0;
        max-width: 100%;
        white-space: normal;
        overflow-wrap: anywhere;
      }
      .hero-meta {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, max-content));
        justify-content: start;
      }
      .hero-meta .pill:last-child:nth-child(odd) {
        grid-column: 1 / -1;
      }
      .timestamp { text-align: left; }
    }
    @media (max-width: 620px) {
      .agents-grid { grid-template-columns: 1fr; }
    }
    @keyframes breathe {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.12); opacity: 0.72; }
    }
  `

  const script = `
    const state = {
      lastUpdated: null,
      events: [],
      eventIds: new Set(),
      stream: null,
      refreshTimer: null,
      fallbackTimer: null,
      streamAvailable: false,
      streamConnected: false,
      hasRenderedEvents: false,
    };

    function escape(value) {
      return ${escapeHtml.toString()}(String(value ?? ''));
    }

    function normalizeStatus(status) {
      return String(status || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    }

    function statusClass(status) {
      const value = normalizeStatus(status);
      if (['running', 'active', 'assigned', 'in_progress', 'ok', 'healthy'].includes(value)) return 'status-' + value;
      if (['idle', 'pending', 'waiting'].includes(value)) return 'status-' + value;
      if (value.includes('block')) return 'status-blocked';
      if (['done', 'completed', 'complete', 'abandoned'].includes(value)) return 'status-' + (value === 'complete' ? 'completed' : value);
      if (value.includes('error') || value.includes('stop')) return 'status-error';
      return 'status-idle';
    }

    function statusBadge(status, live) {
      return '<span class="status-badge ' + statusClass(status) + (live ? ' is-live' : '') + '"><span class="status-dot"></span>' + escape(status || 'unknown') + '</span>';
    }

    function shortId(value) {
      return String(value || '').slice(0, 8) || 'unknown';
    }

    function findCapsuleForTask(task, capsules) {
      if (!task) return null;
      const taskCapsule = task.capsuleId ? capsules.find(capsule => String(capsule.id || '').startsWith(String(task.capsuleId))) : null;
      return taskCapsule || capsules.find(capsule => capsule.taskId === task.id) || null;
    }

    function findInitiative(id, initiatives) {
      if (!id) return null;
      return initiatives.find(initiative => String(initiative.id || '').startsWith(String(id))) || null;
    }

    function extractPrLinks(value) {
      const text = String(value || '');
      const matches = text.match(new RegExp('https://github\\\\.com/[^\\\\s;)]+/pull/\\\\d+', 'g')) || [];
      return [...new Set(matches)];
    }

    function formatScope(scope) {
      if (!scope) return 'No scope reported';
      const paths = Array.isArray(scope.paths) ? scope.paths : [];
      const patterns = Array.isArray(scope.patterns) ? scope.patterns.map(pattern => pattern + '*') : [];
      return paths.concat(patterns).filter(Boolean).join(', ') || 'No scope reported';
    }

    function openCapsules(capsules) {
      return capsules.filter(capsule => ['open', 'in_review', 'blocked'].includes(normalizeStatus(capsule.status)));
    }

    function formatSummary(summary) {
      const value = String(summary || '').trim();
      return value || 'Local multi-agent runtime';
    }

    function agentBuckets(agents) {
      return {
        running: agents.filter(agent => normalizeStatus(agent.state) === 'running'),
        idle: agents.filter(agent => normalizeStatus(agent.state) === 'idle'),
        unhealthy: agents.filter(agent => ['error', 'stopped'].includes(normalizeStatus(agent.state))),
      };
    }

    function taskGroups(tasks) {
      return {
        active: tasks.filter(task => ['assigned', 'in_progress', 'active'].includes(normalizeStatus(task.status))),
        pending: tasks.filter(task => ['pending', 'waiting'].includes(normalizeStatus(task.status))),
        blocked: tasks.filter(task => normalizeStatus(task.status).includes('block')),
        done: tasks.filter(task => ['done', 'completed', 'complete'].includes(normalizeStatus(task.status))),
      };
    }

    function metric(label, value, sub, tone) {
      return '<article class="metric ' + escape(tone || '') + '">' +
        '<div><div class="metric-label">' + escape(label) + '</div><div class="metric-value">' + escape(value) + '</div></div>' +
        '<div class="metric-sub">' + escape(sub) + '</div>' +
      '</article>';
    }

    function renderAgents(agents, counts) {
      if (!agents.length) return '<div class="empty">No agents reported by the supervisor health endpoint.</div>';
      return agents.map(agent => {
        const completed = Number(counts[agent.name] || 0);
        const state = normalizeStatus(agent.state);
        return '<article class="agent-card is-' + escape(state) + '">' +
          '<div class="agent-name">' +
            '<strong>' + escape(agent.name) + '</strong>' +
            statusBadge(agent.state, state === 'running') +
          '</div>' +
          '<div class="subtle">' + escape(agent.lifecycle || 'unknown') + ' lifecycle</div>' +
          '<div class="task-meta">' +
            '<span class="pill mono">' + escape(String(completed)) + ' runs</span>' +
          '</div>' +
        '</article>';
      }).join('');
    }

    function renderCurrentFocus(activeTasks, capsules, initiatives, live) {
      const current = activeTasks.find(task => normalizeStatus(task.status) === 'in_progress') || activeTasks[0] || null;
      if (!current) {
        return '<div class="focus-card"><h4 class="focus-title">No active task reported</h4><div class="subtle">The task pool has no assigned or in-progress work.</div></div>';
      }
      const capsule = findCapsuleForTask(current, capsules);
      const initiative = findInitiative(current.initiativeId, initiatives);
      const prLinks = extractPrLinks(current.result);
      const branch = capsule?.branch || live.brain || 'No branch reported';

      return '<div class="focus-card">' +
        '<div class="task-meta">' + statusBadge(current.status, true) + '<span class="pill">Owner ' + escape(current.assignee || 'unassigned') + '</span>' + (current.priority ? '<span class="pill">P' + escape(String(current.priority)) + '</span>' : '') + '</div>' +
        '<h4 class="focus-title">' + escape(current.title || current.goal || current.id) + '</h4>' +
        '<div class="detail-grid">' +
          '<div class="detail-item"><div class="detail-label">Branch / Brain</div><div class="detail-value mono">' + escape(branch) + '</div></div>' +
          '<div class="detail-item"><div class="detail-label">Capsule</div><div class="detail-value mono">' + escape(capsule ? shortId(capsule.id) + ' · ' + capsule.status : 'No linked capsule') + '</div></div>' +
          '<div class="detail-item"><div class="detail-label">Initiative</div><div class="detail-value">' + escape(initiative ? initiative.title : shortId(current.initiativeId)) + '</div></div>' +
          '<div class="detail-item"><div class="detail-label">Scope</div><div class="detail-value mono">' + escape(formatScope(current.scope)) + '</div></div>' +
          '<div class="detail-item full"><div class="detail-label">PR / Result</div><div class="detail-value">' + (prLinks.length ? prLinks.map(link => '<span class="pill mono">' + escape(link.replace('https://github.com/', '')) + '</span>').join(' ') : escape(current.result || 'No PR or result reported yet')) + '</div></div>' +
        '</div>' +
      '</div>';
    }

    function taskCard(task) {
      const title = task.title || task.goal || task.id || 'Untitled task';
      const meta = [
        task.assignee ? '<span class="pill">Owner ' + escape(task.assignee) + '</span>' : '<span class="pill">Unassigned</span>',
        task.priority ? '<span class="pill">P' + escape(String(task.priority)) + '</span>' : '',
        task.initiativeId ? '<span class="pill mono">I ' + escape(shortId(task.initiativeId)) + '</span>' : '',
        task.capsuleId ? '<span class="pill mono">C ' + escape(shortId(task.capsuleId)) + '</span>' : '',
      ].filter(Boolean).join('');
      const scope = formatScope(task.scope);
      const prLinks = extractPrLinks(task.result);
      return '<article class="task-card">' +
        '<div class="task-meta">' + statusBadge(task.status, ['assigned', 'in_progress', 'active'].includes(normalizeStatus(task.status))) + '</div>' +
        '<strong>' + escape(title) + '</strong>' +
        '<div class="task-meta">' + meta + '</div>' +
        '<div class="task-result mono">Scope: ' + escape(scope) + '</div>' +
        (task.result ? '<div class="task-result">' + (prLinks.length ? prLinks.map(link => '<span class="pill mono">' + escape(link.replace('https://github.com/', '')) + '</span>').join(' ') : escape(task.result)) + '</div>' : '') +
      '</article>';
    }

    function renderLane(label, tasks) {
      return '<div class="task-lane">' +
        '<div class="lane-head"><span>' + escape(label) + '</span><span>' + escape(String(tasks.length)) + '</span></div>' +
        '<div class="task-lane-scroll">' +
          (tasks.length ? tasks.map(taskCard).join('') : '<div class="empty">No ' + escape(label.toLowerCase()) + ' tasks.</div>') +
        '</div>' +
      '</div>';
    }

    function renderTaskBoard(groups) {
      return renderLane('Active', groups.active) +
        renderLane('Pending', groups.pending) +
        renderLane('Blocked', groups.blocked) +
        renderLane('Done', groups.done);
    }

    function renderEvents(events) {
      if (!events.length) return '<div class="empty">No audit entries reported yet.</div>';
      return events.map(event => {
        const kind = normalizeStatus(event.kind || 'log');
        const actor = event.agent || event.source || event.kind || 'runtime';
        const label = event.kind || 'log';
        const readable = String(event.message || '');
        const rawMessage = String(event.raw || event.message || '');
        return '<div class="event-row is-' + escape(kind) + '">' +
          '<div class="event-time mono">' + escape(formatEventTime(event)) + '</div>' +
          '<div class="event-main">' +
            '<div class="event-title"><span>' + escape(actor) + '</span><span class="pill">' + escape(label) + '</span><span class="pill">' + escape(event.source || 'audit') + '</span></div>' +
            '<div class="event-detail">' + escape(readable) + '</div>' +
            '<div class="event-detail mono">Raw: ' + escape(rawMessage || 'empty') + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function eventTimestamp(event) {
      if (!event) return null;
      if (event.timestamp) return event.timestamp;
      const raw = String(event.raw || '').trim();
      if (raw.startsWith('{')) {
        try {
          const record = JSON.parse(raw);
          return record.ts || record.timestamp || null;
        } catch {
          return null;
        }
      }
      return null;
    }

    function formatEventTime(event) {
      const timestamp = eventTimestamp(event);
      if (timestamp) {
        const date = new Date(timestamp);
        if (!Number.isNaN(date.getTime())) {
          return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          });
        }
      }
      return event.time || '--:--';
    }

    function isEventsPinnedToBottom(container) {
      if (!container) return true;
      return container.scrollHeight - container.scrollTop - container.clientHeight < 32;
    }

    function scrollEventsToBottom(container) {
      if (container) container.scrollTop = container.scrollHeight;
    }

    function renderEventHistory() {
      document.getElementById('events').innerHTML = renderEvents(state.events);
    }

    function replaceEventHistory(events) {
      const container = document.getElementById('events');
      const shouldFollow = !state.hasRenderedEvents || isEventsPinnedToBottom(container);
      state.events = [];
      state.eventIds = new Set();
      for (const event of events || []) {
        if (!event || !event.id || state.eventIds.has(event.id)) continue;
        state.eventIds.add(event.id);
        state.events.push(event);
      }
      renderEventHistory();
      state.hasRenderedEvents = true;
      if (shouldFollow) scrollEventsToBottom(container);
    }

    function appendStreamEvent(event) {
      if (!event || !event.id || state.eventIds.has(event.id)) return;
      const container = document.getElementById('events');
      const pinnedToBottom = isEventsPinnedToBottom(container);
      state.eventIds.add(event.id);
      state.events.push(event);
      renderEventHistory();
      if (pinnedToBottom) scrollEventsToBottom(container);
    }

    function scheduleRefresh(delay) {
      if (state.refreshTimer) return;
      state.refreshTimer = window.setTimeout(async () => {
        state.refreshTimer = null;
        try {
          await refresh();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          updateText('dashboard-note', message);
        }
      }, delay);
    }

    function setTransportMode(label) {
      updateText('transport-mode', label);
    }

    function renderCapsules(capsules, tasks) {
      const visible = openCapsules(capsules).slice(0, 8);
      if (!visible.length) return '<div class="empty">No open or in-review capsules reported. Historical capsules may still exist in the task board data.</div>';
      return visible.map(capsule => {
        const task = tasks.find(item => item.id === capsule.taskId);
        const blocked = Array.isArray(capsule.blockedBy) && capsule.blockedBy.length ? 'Blocked by ' + capsule.blockedBy.map(shortId).join(', ') : 'No blockers reported';
        return '<div class="capsule-row is-' + escape(normalizeStatus(capsule.status)) + '">' +
          '<div class="task-meta">' + statusBadge(capsule.status, ['open', 'in_review'].includes(normalizeStatus(capsule.status))) + '<span class="pill">Owner ' + escape(capsule.ownerAgent || 'unknown') + '</span>' + '<span class="pill">Reviewer ' + escape(capsule.reviewer || 'unknown') + '</span></div>' +
          '<div class="capsule-title">' + escape(capsule.goal || task?.title || capsule.id) + '</div>' +
          '<div class="event-detail mono">Branch: ' + escape(capsule.branch || 'No branch reported') + '</div>' +
          '<div class="event-detail mono">Task: ' + escape(task ? shortId(task.id) + ' · ' + task.status : shortId(capsule.taskId)) + ' · ' + escape(blocked) + '</div>' +
        '</div>';
      }).join('');
    }

    function renderArtifacts(artifacts) {
      if (!artifacts.length) return '<div class="empty">No artifact files found in agent output directories yet.</div>';
      return artifacts.map(artifact => (
        '<div class="artifact-row">' +
          '<div><div class="artifact-title">' + escape(artifact.agent) + '</div>' +
          '<div class="artifact-detail">' + escape(artifact.kind) + ' output files</div></div>' +
          '<span class="status-badge status-active">' + escape(String(artifact.cnt || 0)) + '</span>' +
        '</div>'
      )).join('');
    }

    function renderHealthChecks(items) {
      if (!items.length) return '<div class="empty">No health checks returned.</div>';
      return items.map(item => (
        '<div class="health-row"><span>' + escape(item.label) + '</span>' + statusBadge(item.status, ['healthy', 'ok', 'active'].includes(normalizeStatus(item.status))) + '</div>'
      )).join('');
    }

    function renderDiagnostics(data, groups, agents, live, capsules) {
      const rows = [];
      const healthTimestamp = data.health && data.health.timestamp ? new Date(data.health.timestamp) : null;
      const healthAge = healthTimestamp && !Number.isNaN(healthTimestamp.getTime()) ? Math.max(0, Math.round((Date.now() - healthTimestamp.getTime()) / 1000)) : null;
      rows.push({ level: healthAge !== null && healthAge > 15 ? 'warn' : 'ok', title: 'Health snapshot age', detail: healthAge === null ? 'No health timestamp reported.' : healthAge + 's old from /health.' });
      rows.push({ level: live.streamAvailable ? 'ok' : 'warn', title: 'Runtime event stream', detail: live.streamAvailable ? 'Event history is sourced from the supervisor event bus and live SSE endpoint.' : 'Event stream is unavailable; state panels are refreshed from snapshots only.' });
      rows.push({ level: live.raw ? 'ok' : 'warn', title: 'Legacy dashboard text', detail: live.raw ? 'live-dashboard.txt is present for summary metadata only; it is not used for event history.' : 'live-dashboard.txt is not present.' });
      rows.push({ level: groups.blocked.length ? 'warn' : 'ok', title: 'Blocked work', detail: groups.blocked.length ? groups.blocked.length + ' blocked task(s) need attention.' : 'No blocked tasks reported by the task pool.' });
      rows.push({ level: openCapsules(capsules).length ? 'ok' : 'warn', title: 'Open capsules', detail: openCapsules(capsules).length + ' open/in-review capsule(s) connect tasks to branches.' });
      rows.push({ level: agents.some(agent => normalizeStatus(agent.state) === 'running') ? 'ok' : 'warn', title: 'Running agents', detail: agents.filter(agent => normalizeStatus(agent.state) === 'running').map(agent => agent.name).join(', ') || 'No agents currently running.' });
      return rows.map(row => '<div class="diagnostic-row ' + escape(row.level === 'ok' ? '' : row.level) + '"><div class="event-title">' + escape(row.title) + '</div><div class="event-detail">' + escape(row.detail) + '</div></div>').join('');
    }

    function updateText(id, value) {
      const node = document.getElementById(id);
      if (node) node.textContent = value;
    }

    async function refresh() {
      const params = new URLSearchParams(window.location.search);
      const dataUrl = params.get('data') || '/dashboard/data';
      const response = await fetch(dataUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error('Dashboard data request failed with status ' + response.status);
      const data = await response.json();
      state.lastUpdated = new Date();

      const health = data.health || {};
      const runtime = health.runtime || {};
      const loop = health.loop || {};
      const agents = health.agents || [];
      const tasks = data.tasks || [];
      const initiatives = data.initiatives || [];
      const capsules = data.capsules || [];
      const artifacts = data.artifacts || [];
      const live = data.live || {};
      state.streamAvailable = live.streamAvailable === true;
      const agentState = agentBuckets(agents);
      const groups = taskGroups(tasks);
      const activeCapsules = capsules.filter(capsule => ['open', 'in_review'].includes(normalizeStatus(capsule.status)));
      const outputCount = artifacts.reduce((sum, artifact) => sum + Number(artifact.cnt || 0), 0);

      updateText('mission-title', formatSummary(live.summary));
      updateText('mission-subtitle', live.brain ? 'Brain: ' + live.brain : 'Runtime brain is not reported by the supervisor snapshot.');
      updateText('run-id', loop.runId || 'unknown');
      updateText('loop-id', String(loop.currentLoop ?? 0));
      updateText('connection-label', data.connectionLabel || 'local supervisor');
      updateText('supervisor-url', 'http://127.0.0.1:' + String(data.port || 'unknown') + '/dashboard');
      updateText('last-updated', 'Updated ' + state.lastUpdated.toLocaleTimeString());
      updateText('initiative-count', String(runtime.activeInitiatives ?? initiatives.filter(item => normalizeStatus(item.status) === 'active').length));
      updateText('capsule-count', String(runtime.activeCapsules ?? activeCapsules.length));
      updateText('dashboard-note', live.note || 'Waiting for supervisor audit timeline.');

      document.getElementById('top-status').innerHTML = statusBadge(health.status || 'unknown', normalizeStatus(health.status) === 'ok');
      document.getElementById('hero-meta').innerHTML = [
        '<span class="pill mono">Port ' + escape(String(data.port || 'unknown')) + '</span>',
        '<span class="pill">' + escape(String(agentState.running.length)) + ' running agents</span>',
        '<span class="pill">' + escape(String(groups.active.length)) + ' active tasks</span>',
        '<span class="pill">' + escape(String(groups.pending.length + groups.blocked.length)) + ' waiting or blocked</span>',
      ].join('');

      document.getElementById('metrics').innerHTML = [
        metric('Health', health.status || 'unknown', agentState.unhealthy.length ? agentState.unhealthy.length + ' agents need attention' : 'Supervisor and data endpoints responding', 'health'),
        metric('Running Agents', agentState.running.length + '/' + agents.length, agentState.idle.length + ' idle, ' + agentState.unhealthy.length + ' unhealthy', 'active'),
        metric('Active Tasks', groups.active.length, groups.pending.length + ' pending, ' + groups.blocked.length + ' blocked', 'active'),
        metric('Blocked', groups.blocked.length, groups.blocked.length ? 'Needs operator attention' : 'No blocked tasks reported', 'blocked'),
        metric('Done', groups.done.length, 'Completed in this task pool', 'done'),
        metric('Outputs', outputCount, artifacts.length + ' agent/type groups', 'output'),
      ].join('');

      document.getElementById('focus').innerHTML = renderCurrentFocus(groups.active, capsules, initiatives, live);
      document.getElementById('agents').innerHTML = renderAgents(agents, runtime.completedRunsByAgent || {});
      document.getElementById('tasks').innerHTML = renderTaskBoard(groups);
      replaceEventHistory(live.events || []);
      document.getElementById('capsules').innerHTML = renderCapsules(capsules, tasks);
      document.getElementById('artifacts').innerHTML = renderArtifacts(artifacts);
      document.getElementById('health-checks').innerHTML = renderHealthChecks(data.healthChecks || []);
      document.getElementById('diagnostics').innerHTML = renderDiagnostics(data, groups, agents, live, capsules);
      document.getElementById('error-banner').innerHTML = '';
    }

    function connectStream() {
      const params = new URLSearchParams(window.location.search);
      const eventsUrl = params.get('events') || '/dashboard/events';
      if (state.stream) {
        state.stream.close();
      }
      if (!state.streamAvailable) {
        setTransportMode('Snapshot fallback');
        return;
      }
      const stream = new EventSource(eventsUrl);
      state.stream = stream;
      state.streamConnected = false;
      setTransportMode('Connecting stream…');
      stream.onopen = () => {
        state.streamConnected = true;
        setTransportMode('Live stream');
        scheduleRefresh(0);
      };
      stream.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data);
          appendStreamEvent(event);
          scheduleRefresh(0);
        } catch {
          scheduleRefresh(0);
        }
      };
      stream.onerror = () => {
        state.streamConnected = false;
        setTransportMode('Snapshot fallback');
        stream.close();
        if (state.stream === stream) state.stream = null;
        scheduleRefresh(0);
        window.setTimeout(connectStream, 1000);
      };
    }

    async function init() {
      try {
        await refresh();
        connectStream();
        if (!state.streamAvailable) setTransportMode('Snapshot fallback');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateText('dashboard-note', message);
        const status = document.getElementById('top-status');
        if (status) status.innerHTML = statusBadge('error', false);
        const banner = document.getElementById('error-banner');
        if (banner) banner.innerHTML = '<div class="diagnostic-row fail"><div class="event-title">Dashboard data unavailable</div><div class="event-detail">' + escape(message) + '</div><div class="event-detail">The page is still loaded, but live state is stale until /dashboard/data responds again.</div></div>';
      }
      state.fallbackTimer = window.setInterval(() => {
        scheduleRefresh(0);
      }, 3000);
    }

    init();
  `

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>wanman Dashboard</title>
      <style>${styles}</style>
    </head>
    <body>
      <main class="shell">
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark">w</div>
            <div>
              <h1>wanman Dashboard</h1>
              <p>Local read-only mission control for the live agent matrix.</p>
            </div>
          </div>
          <div class="top-actions">
            <span id="top-status" class="status-badge status-idle"><span class="status-dot"></span>loading</span>
            <span class="pill mono" id="connection-label">connecting</span>
            <span class="pill">Read only</span>
            <span class="pill" id="transport-mode">Connecting live stream…</span>
          </div>
        </header>

        <section class="hero">
          <div>
            <div class="eyebrow">Current run</div>
            <h2 id="mission-title">Loading live runtime state...</h2>
            <p class="mission" id="mission-subtitle">Waiting for supervisor data.</p>
            <div class="hero-meta" id="hero-meta"></div>
          </div>
          <div class="run-strip">
            <div class="run-fact">
              <div class="fact-label">Run ID</div>
              <div class="fact-value mono" id="run-id">unknown</div>
            </div>
            <div class="run-fact">
              <div class="fact-label">Loop</div>
              <div class="fact-value mono" id="loop-id">0</div>
            </div>
            <div class="run-fact">
              <div class="fact-label">Active Initiatives</div>
              <div class="fact-value" id="initiative-count">0</div>
            </div>
            <div class="run-fact">
              <div class="fact-label">Open Capsules</div>
              <div class="fact-value" id="capsule-count">0</div>
            </div>
            <div class="run-fact wide">
              <div class="fact-label">Connected Supervisor</div>
              <div class="fact-value wrap mono" id="supervisor-url">http://127.0.0.1/dashboard</div>
            </div>
          </div>
        </section>

        <section class="metrics" id="metrics"></section>
        <div id="error-banner"></div>

        <section class="content-grid">
          <div class="dashboard-pair pair-focus">
            <section class="panel focus-panel">
              <div class="panel-header">
                <div>
                  <h3>Current Focus</h3>
                  <div class="panel-subtitle">The active task, owner, branch/brain, capsule, scope, and PR/result metadata.</div>
                </div>
              </div>
              <div class="focus-grid" id="focus"></div>
            </section>

            <section class="panel events-panel">
              <div class="panel-header">
                <div>
                  <h3>Event History</h3>
                  <div class="panel-subtitle">Unified audit timeline from runtime logs and the supervisor event bus. Times use your browser's local timezone; raw JSON or raw line is preserved for debugging.</div>
                </div>
              </div>
              <div class="events" id="events"></div>
            </section>
          </div>

          <div class="dashboard-pair pair-agents">
            <section class="panel agents-panel">
              <div class="panel-header">
                <div>
                  <h3>Agents</h3>
                  <div class="panel-subtitle">Running, idle, and unhealthy states from the supervisor health snapshot.</div>
                </div>
                <div class="timestamp" id="last-updated">Loading...</div>
              </div>
              <div class="agents-grid" id="agents"></div>
            </section>

            <section class="panel capsules-panel">
              <div class="panel-header">
                <div>
                  <h3>Capsules, Branches, PRs</h3>
                  <div class="panel-subtitle">Open work capsules connect durable tasks to branches, owners, reviewers, and blockers.</div>
                </div>
              </div>
              <div class="capsules-list" id="capsules"></div>
            </section>
          </div>

          <section class="panel task-board-panel" id="task-board-panel">
            <div class="panel-header">
              <div>
                <h3>Task Board</h3>
                <div class="panel-subtitle">Grouped by state so active, waiting, blocked, and completed work are easy to compare.</div>
              </div>
            </div>
            <div class="task-lanes" id="tasks"></div>
          </section>

          <div class="dashboard-pair pair-diagnostics">
            <section class="panel health-panel">
              <div class="panel-header">
                <div>
                  <h3>Health & Diagnostics</h3>
                  <div class="panel-subtitle">Core checks and inferred stale/missing data warnings.</div>
                </div>
              </div>
              <div class="health-scroll">
                <div class="health-list" id="health-checks"></div>
                <div class="diagnostics-list" id="diagnostics"></div>
              </div>
            </section>

            <section class="panel outputs-panel">
              <div class="panel-header">
                <div>
                  <h3>Outputs</h3>
                  <div class="panel-subtitle">Artifact files grouped by agent and type.</div>
                </div>
              </div>
              <div class="artifacts" id="artifacts"></div>
            </section>
          </div>
        </section>
      </main>
      <script>${script}</script>
    </body>
  </html>`
}
