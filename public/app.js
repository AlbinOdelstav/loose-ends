// Loose Ends board UI. Vanilla JS, no build. All item text goes through textContent.
'use strict';

(function () {
  const TOKEN = (document.querySelector('meta[name="le-token"]') || {}).content || '';
  const GROUPS = [
    { id: 'active', label: 'Active' },
    { id: 'waiting', label: 'Waiting' },
    { id: 'parked', label: 'Parked' },
  ];
  const KNOWN = new Set(['active', 'waiting', 'parked', 'done']);
  const DAY = 86400000;
  const LIVE_TTL = 30000;

  const state = {
    config: { jiraBaseUrl: null, canStart: false, platform: '' },
    items: [],
    selected: new Map(), // key -> Set of step texts picked for a multi-step session
    live: new Map(), // key -> { at, value }
    doneOpen: false,
    showAllSessions: new Set(), // item keys whose finished/older sessions are expanded
    expandedSummary: new Set(), // item keys whose summary is shown in full
    pendingRender: false,
  };

  const board = document.getElementById('board');
  const toastEl = document.getElementById('toast');
  const connEl = document.getElementById('conn');
  const countsEl = document.getElementById('counts');

  // ---------- helpers ----------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'className') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  // Small stroke icons (16x16), built with DOM APIs so they work under the strict CSP.
  const ICONS = {
    play: [['path', { d: 'M5 3.5v9l7.5-4.5z', fill: 'currentColor', stroke: 'none' }]],
    check: [['path', { d: 'M3.5 8.5l3 3 6-7' }]],
    copy: [['rect', { x: '5.5', y: '5.5', width: '8', height: '8', rx: '1.5' }], ['path', { d: 'M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2' }]],
    branch: [['circle', { cx: '4.5', cy: '3.5', r: '1.5' }], ['circle', { cx: '4.5', cy: '12.5', r: '1.5' }], ['circle', { cx: '11.5', cy: '5.5', r: '1.5' }], ['path', { d: 'M4.5 5v6M11.5 7c0 3-7 2-7 4' }]],
    clock: [['circle', { cx: '8', cy: '8', r: '5.5' }], ['path', { d: 'M8 5v3l2 1.5' }]],
    alert: [['path', { d: 'M8 2.5l6 10.5H2z' }], ['path', { d: 'M8 6.5v3M8 11.5v.01' }]],
    edit: [['path', { d: 'M10.5 3l2.5 2.5L6 12.5H3.5V10z' }]],
    archive: [['rect', { x: '2.5', y: '3', width: '11', height: '3', rx: '1' }], ['path', { d: 'M3.5 6v6.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6M6.5 9h3' }]],
    chevron: [['path', { d: 'M6 4l4 4-4 4' }]],
    pr: [['circle', { cx: '4.5', cy: '3.5', r: '1.5' }], ['circle', { cx: '4.5', cy: '12.5', r: '1.5' }], ['circle', { cx: '11.5', cy: '12.5', r: '1.5' }], ['path', { d: 'M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6' }]],
    threads: [['path', { d: 'M3 4h10M3 8h6M3 12h8' }]],
    reopen: [['path', { d: 'M3 8a5 5 0 1 0 1.5-3.5M3 2.5v2.5h2.5' }]],
  };
  function icon(name, size = 14) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of ICONS[name] || []) {
      const node = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      svg.append(node);
    }
    return svg;
  }

  function iconButton(name, title, onclick, extraClass) {
    return el('button', {
      type: 'button',
      className: `icon-btn${extraClass ? ` ${extraClass}` : ''}`,
      title,
      'aria-label': title,
      onclick: (e) => { e.stopPropagation(); onclick(e); },
    }, icon(name));
  }

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
  }

  function age(iso) {
    const t = Date.parse(iso || '');
    if (Number.isNaN(t)) return null;
    const d = Date.now() - t;
    if (d < 60000) return 'just now';
    if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
    if (d < DAY) return `${Math.floor(d / 3600000)}h ago`;
    return `${Math.floor(d / DAY)}d ago`;
  }

  function freshness(item) {
    const ts = [Date.parse(item.updated || ''), Date.parse(item.lastCheckpoint || '')].filter((n) => !Number.isNaN(n));
    if (!ts.length) return null;
    const days = (Date.now() - Math.max(...ts)) / DAY;
    if (days > 21) return { label: 'Very stale', cls: 'red' };
    if (days > 7) return { label: 'Stale', cls: 'amber' };
    return null;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  async function api(method, url, body) {
    const opts = { method, headers: {} };
    if (method !== 'GET') {
      opts.headers['X-Loose-Ends-Token'] = TOKEN;
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body || {});
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, ok: res.ok, data };
  }

  async function mutate(method, url, body) {
    const r = await api(method, url, body);
    if (r.status === 409) {
      toast('Item changed on disk, reloaded');
      await loadItems();
      return null;
    }
    if (!r.ok) {
      toast((r.data && r.data.error) || `Request failed (${r.status})`);
      return null;
    }
    return r.data;
  }

  const itemUrl = (key) => `/api/items/${encodeURIComponent(key)}`;

  // Steps picked for a multi-step session. Selection is by text so it survives reloads that
  // shift indices; done steps are never selected.
  function selectedSteps(item) {
    const sel = state.selected.get(item.key) || new Set();
    return (item.steps || []).filter((s) => !s.done && sel.has(s.text)).map((s) => s.index);
  }
  const openStepIndices = (item) => (item.steps || []).filter((s) => !s.done).map((s) => s.index);

  function toggleSelected(item, step) {
    const set = state.selected.get(item.key) || new Set();
    if (set.has(step.text)) set.delete(step.text); else set.add(step.text);
    state.selected.set(item.key, set);
    render();
  }

  async function copyText(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch {
      toast('Clipboard not available');
    }
  }

  // ---------- live facts ----------
  const liveQueue = [];
  let liveRunning = 0;

  function requestLive(key, target) {
    const cached = state.live.get(key);
    if (cached && Date.now() - cached.at < LIVE_TTL) {
      renderLive(target, cached.value);
      return;
    }
    liveQueue.push({ key, target });
    pumpLive();
  }

  function pumpLive() {
    while (liveRunning < 3 && liveQueue.length) {
      const job = liveQueue.shift();
      liveRunning++;
      api('GET', `${itemUrl(job.key)}/live`)
        .then((r) => {
          if (r.ok && r.data) {
            state.live.set(job.key, { at: Date.now(), value: r.data });
            if (job.target.isConnected) renderLive(job.target, r.data);
          }
        })
        .catch(() => {})
        .finally(() => { liveRunning--; pumpLive(); });
    }
  }

  // Live git/PR facts go into the card's meta line (target is a span inside it).
  function renderLive(target, value) {
    target.replaceChildren();
    const g = value && value.git;
    if (g && g.ok) {
      if (g.dirty) target.append(el('span', { className: 'meta-item amber', title: 'Uncommitted changes in the working directory', text: `${g.dirty} uncommitted` }));
      if (g.ahead) target.append(el('span', { className: 'meta-item', title: 'Commits not pushed', text: `↑${g.ahead}` }));
      if (g.behind) target.append(el('span', { className: 'meta-item', title: 'Commits to pull', text: `↓${g.behind}` }));
    }
    const pr = value && value.pr;
    if (pr && pr.ok) {
      const c = pr.checks || {};
      const cls = c.fail ? 'red' : c.pending ? 'amber' : String(pr.state || '').toUpperCase() === 'MERGED' ? 'green' : '';
      const label = `#${pr.number ?? '?'} ${String(pr.state || '').toLowerCase()}${pr.isDraft ? ' draft' : ''}`;
      const item = el('span', { className: `meta-item ${cls}`.trim() }, icon('pr', 13));
      if (typeof pr.url === 'string' && pr.url.startsWith('https://')) {
        item.append(el('a', { href: pr.url, target: '_blank', rel: 'noopener noreferrer', text: label }));
      } else {
        item.append(label);
      }
      if (c.total) item.title = `Checks: ${c.pass}/${c.total} passing${c.fail ? `, ${c.fail} failing` : ''}${c.pending ? `, ${c.pending} pending` : ''}`;
      target.append(item);
      if (pr.reviewDecision) target.append(el('span', { className: 'meta-item', text: pr.reviewDecision.toLowerCase().replace(/_/g, ' ') }));
    }
  }

  // The live facts span uses display: contents (it has no box), so the observer watches its parent.
  const liveTargets = new WeakMap();
  let observer = null;
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer.unobserve(e.target);
        const target = liveTargets.get(e.target);
        if (target) requestLive(target.dataset.key, target);
      }
    }, { rootMargin: '200px' });
  }

  // ---------- rendering ----------
  // Steps in a chosen set whose earlier (not done) steps in the same ordered sequence aren't in it.
  function dependencyWarnings(item, chosen) {
    const sel = new Set(chosen);
    const byIndex = new Map((item.steps || []).map((s) => [s.index, s]));
    const out = [];
    const noted = new Set();
    for (const s of item.steps || []) {
      if (!s.ordered || s.done || !sel.has(s.index)) continue;
      for (const b of s.blockedBy || []) {
        const blocker = byIndex.get(b);
        if (!blocker || blocker.done || sel.has(b) || noted.has(`${s.seqId}:${b}`)) continue;
        noted.add(`${s.seqId}:${b}`);
        const where = s.track ? ` in "${s.track}"` : '';
        out.push(`Step ${s.seq}${where} depends on step ${blocker.seq} ("${blocker.text}"), which isn't done or included.`);
      }
    }
    return out;
  }

  function warningBox(warnings) {
    const box = el('div', { className: 'dep-warning', role: 'status' });
    for (const w of warnings) box.append(el('div', { text: w }));
    box.hidden = warnings.length === 0;
    return box;
  }

  // One step row: done circle, number + text, and hover actions (select for a multi-step
  // session, or start a session for just this step). Clicking the row toggles selection.
  function renderStep(item, s, isSelected) {
    const cls = ['step'];
    if (s.done) cls.push('done');
    if (s.ordered && !s.done && !s.isNext) cls.push('later');
    if (isSelected) cls.push('selected');
    const li = el('li', { className: cls.join(' ') });

    const check = el('button', {
      type: 'button',
      className: 'check',
      title: s.done ? 'Mark as not done' : 'Mark as done',
      'aria-label': s.done ? 'Mark as not done' : 'Mark as done',
      onclick: async (e) => {
        e.stopPropagation();
        const r = await mutate('PUT', `${itemUrl(item.key)}/steps/${s.index}`, { rev: item.rev, done: !s.done });
        if (r) replaceItem(r);
      },
    }, icon('check', 11));

    const text = el('div', { className: 'step-text' });
    if (s.ordered) text.append(el('span', { className: 'step-num', text: `${s.seq}.` }));
    text.append(document.createTextNode(s.text));
    if (s.isNext) text.append(el('span', { className: 'next-tag', text: 'Next' }));
    if (s.ordered && !s.done && !s.isNext) text.title = 'Comes after earlier steps in this sequence';

    const actions = el('div', { className: 'step-actions' });
    if (!s.done) {
      actions.append(el('span', { className: 'select-mark', title: isSelected ? 'Selected' : 'Select', 'aria-hidden': 'true' }, icon('check', 10)));
      if (state.config.canStart && item.cwd) {
        actions.append(iconButton('play', 'Start a session for this step', () => confirmAndStart(item, [s.index]), 'play'));
      }
      li.tabIndex = 0;
      li.setAttribute('role', 'checkbox');
      li.setAttribute('aria-checked', String(isSelected));
      li.addEventListener('click', () => toggleSelected(item, s));
      li.addEventListener('keydown', (e) => {
        if (e.target === li && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggleSelected(item, s); }
      });
    }
    li.append(check, text, actions);
    return li;
  }

  function renderSteps(item) {
    const wrap = el('div', { className: 'steps-wrap' });
    const steps = item.steps || [];
    const tracks = item.tracks && item.tracks.length ? item.tracks : [{ name: null, steps: steps.map((s) => s.index) }];
    const showTracks = tracks.length > 1 || tracks.some((t) => t.name !== null);
    const byIndex = new Map(steps.map((s) => [s.index, s]));
    const chosen = new Set(selectedSteps(item));

    for (const t of tracks) {
      const track = el('div', { className: 'track' });
      const tSteps = t.steps.map((i) => byIndex.get(i)).filter(Boolean);
      if (showTracks) {
        const done = tSteps.filter((s) => s.done).length;
        track.append(el('div', { className: 'track-title' },
          t.name === null ? 'General' : t.name,
          el('span', { className: 'track-progress', text: `${done}/${tSteps.length}` })));
      }
      const list = el('ul', { className: 'steps' });
      for (const s of tSteps) list.append(renderStep(item, s, chosen.has(s.index)));
      track.append(list);
      wrap.append(track);
    }
    const warnings = dependencyWarnings(item, [...chosen]);
    if (warnings.length) wrap.append(warningBox(warnings));
    return wrap;
  }

  // Same rule as SESSION_ID_RE in lib/keys.mjs (this file is a plain browser script).
  const SESSION_ID_RE = /^[A-Za-z0-9-]{1,100}$/;
  const RECENT_UNTRACKED = 2;

  // Session tree. open: true = open thread, false = finished, null = untracked (never classified).
  // Open threads are always listed; the most recent untracked ones too. Finished and older
  // untracked sessions are behind the section toggle. A hidden parent's children move up a level.
  function renderSessions(item) {
    const all = [];
    const collect = (nodes) => (nodes || []).forEach((n) => { all.push(n); collect(n.children); });
    collect(item.sessionTree);
    if (!all.length) return null;
    const order = new Map((item.sessions || []).map((s, i) => [s.id, i]));
    const untracked = all.filter((n) => n.open !== true && n.open !== false)
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const recentUntracked = new Set(untracked.slice(-RECENT_UNTRACKED));
    const expanded = state.showAllSessions.has(item.key);
    const isDefaultVisible = (n) => n.open === true || recentUntracked.has(n);
    const hiddenCount = all.filter((n) => !isDefaultVisible(n)).length;
    const openCount = all.filter((n) => n.open === true).length;

    const box = el('div', { className: `sessions${expanded ? ' expanded' : ''}` });
    const summaryBits = [plural(all.length, 'session')];
    if (openCount) summaryBits.push(`${openCount} open`);
    const head = el('button', {
      type: 'button',
      className: 'sessions-head',
      'aria-expanded': String(expanded),
      title: hiddenCount ? (expanded ? 'Hide finished and older sessions' : 'Show all sessions') : '',
      onclick: () => {
        if (!hiddenCount) return;
        if (expanded) state.showAllSessions.delete(item.key); else state.showAllSessions.add(item.key);
        render();
      },
    });
    if (hiddenCount) head.append(el('span', { className: 'chev' }, icon('chevron', 12)));
    head.append(el('span', { className: 'section-label', text: 'Sessions' }),
      el('span', { className: 'track-progress', text: summaryBits.join(' · ') }));
    box.append(head);

    const list = el('ul', { className: 'session-list' });
    const renderNode = (node, depth) => {
      const visible = expanded || isDefaultVisible(node);
      if (visible) list.append(renderSessionRow(item, node, depth));
      for (const c of node.children || []) renderNode(c, visible ? depth + 1 : depth);
    };
    for (const root of item.sessionTree || []) renderNode(root, 0);
    if (list.childElementCount) box.append(list);
    return box;
  }

  function renderSessionRow(item, node, depth) {
    const stateCls = node.open === true ? 'open' : node.open === false ? 'closed' : 'untracked';
    const li = el('li', { className: `session ${stateCls}` });
    li.style.setProperty('--depth', String(Math.min(depth, 5)));
    const validId = typeof node.id === 'string' && SESSION_ID_RE.test(node.id);

    const line = el('div', { className: 'session-line' });
    if (depth) line.append(el('span', { className: 'session-fork', text: 'fork' }));
    line.append(el('span', { className: 'session-id', title: node.id || '', text: node.id ? node.id.slice(0, 8) : '(no id)' }));
    line.append(el('span', { text: node.open === true ? 'Open thread' : node.open === false ? 'Finished' : 'Not classified' }));
    if (node.branch) line.append(el('span', { className: 'meta-item' }, icon('branch', 12), node.branch));
    const ended = age(node.endedAt);
    if (ended) line.append(el('span', { text: ended }));
    const main = el('div', { className: 'session-main' }, line);
    if (node.note) main.append(el('div', { className: 'session-note', text: node.note }));

    const actions = el('div', { className: 'session-actions' });
    if (validId) {
      const next = node.open !== true;
      actions.append(iconButton(node.open === true ? 'check' : 'reopen',
        node.open === true ? 'Mark finished' : 'Mark as open thread',
        async () => {
          const r = await mutate('PATCH', `${itemUrl(item.key)}/sessions/${encodeURIComponent(node.id)}`, { rev: item.rev, open: next });
          if (r) replaceItem(r);
        }));
      actions.append(iconButton('copy',
        node.cwd ? `Copy resume command (run it in ${node.cwd})` : 'Copy resume command',
        () => copyText(`claude --resume ${node.id}`, 'Resume command')));
    }
    li.append(el('span', { className: 'session-dot' }), main, actions);
    return li;
  }

  // Shows what will be done and the exact prompt (as the server builds it), then launches.
  async function confirmAndStart(item, steps) {
    if (document.querySelector('dialog.confirm')) return;
    const r = await api('GET', `${itemUrl(item.key)}/prompt?steps=${steps.join(',')}`);
    if (!r.ok || !r.data) {
      toast((r.data && r.data.error) || 'Could not build prompt');
      return;
    }
    const byIndex = new Map((item.steps || []).map((s) => [s.index, s]));
    const dialog = el('dialog', { className: 'confirm', 'aria-label': 'Start session' });
    const launchBtn = el('button', { type: 'button', className: 'btn primary' }, icon('play', 12), 'Launch session');
    const cancelBtn = el('button', { type: 'button', className: 'btn', text: 'Cancel' });

    const body = el('div', { className: 'dialog-body' });
    const stepList = el('ol', { className: 'dialog-steps' });
    steps.map((i) => byIndex.get(i)).filter(Boolean).forEach((s, n) => {
      stepList.append(el('li', {}, el('span', { className: 'n', text: String(n + 1) }), el('span', { text: s.text })));
    });
    if (steps.length) body.append(stepList);
    else body.append(el('p', { className: 'no-steps', text: 'No steps chosen: Claude will review the item and propose next steps.' }));
    const warnings = dependencyWarnings(item, steps);
    if (warnings.length) body.append(warningBox(warnings));
    const details = el('details', { className: 'prompt-details' },
      el('summary', { text: 'Show the full prompt' }),
      el('pre', { className: 'prompt-preview', text: r.data.prompt }));
    body.append(details);

    dialog.append(
      el('div', { className: 'dialog-head' },
        el('h2', { text: `Start a session on ${item.key}` }),
        el('p', { text: `Opens a new terminal in ${item.cwd || '(no working directory)'} and starts Claude with these steps.` })),
      body,
      el('div', { className: 'dialog-foot' }, cancelBtn, launchBtn),
    );
    const close = () => { try { dialog.close(); } catch { /* ignore */ } dialog.remove(); };
    cancelBtn.addEventListener('click', close);
    dialog.addEventListener('cancel', close);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
    launchBtn.addEventListener('click', async () => {
      launchBtn.disabled = true;
      const res = await mutate('POST', `${itemUrl(item.key)}/start`, { rev: item.rev, steps });
      close();
      if (res) {
        state.selected.delete(item.key);
        render();
        toast(`Session started (${res.via})`);
      }
    });
    document.body.append(dialog);
    dialog.showModal();
    launchBtn.focus();
  }

  function renderCard(item) {
    if (item.parseError) {
      return el('article', { className: 'card error' },
        el('div', { className: 'card-top' },
          el('span', { className: 'key', text: item.key }),
          el('span', { className: 'spacer' }),
          el('span', { className: 'pill red', text: 'Unreadable' })),
        el('p', { className: 'blockers' }, icon('alert'), `Could not read this item: ${item.parseError}`));
    }
    const card = el('article', { className: 'card' });

    // top row: key, Jira status, warnings, status selector
    const top = el('div', { className: 'card-top' });
    if (item.jiraUrl && /^https?:\/\//.test(item.jiraUrl)) {
      top.append(el('a', { className: 'key', href: item.jiraUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Open in Jira', text: item.key }));
    } else {
      top.append(el('span', { className: 'key', text: item.key }));
    }
    if (item.jiraStatus) top.append(el('span', { className: 'pill', title: 'Jira status at last checkpoint', text: item.jiraStatus }));
    if (item.parseWarnings && item.parseWarnings.length) {
      top.append(el('span', {
        className: 'pill red',
        title: `${item.parseWarnings.join('\n')}\nFix the item file by hand or run /checkpoint again.`,
        text: `${plural(item.parseWarnings.length, 'field')} unreadable`,
      }));
    }
    const fresh = freshness(item);
    if (fresh) top.append(el('span', { className: `pill ${fresh.cls}`, text: fresh.label }));
    top.append(el('span', { className: 'spacer' }));
    const statusSel = el('select', { className: 'status-select', 'aria-label': 'Status', 'data-status': item.status });
    const statuses = KNOWN.has(item.status) ? ['active', 'waiting', 'parked', 'done'] : [item.status, 'active', 'waiting', 'parked', 'done'];
    for (const s of statuses) statusSel.append(el('option', { value: s, text: s }));
    statusSel.value = item.status;
    statusSel.addEventListener('change', async () => {
      const r = await mutate('PATCH', itemUrl(item.key), { rev: item.rev, status: statusSel.value });
      if (r) replaceItem(r); else render();
    });
    top.append(statusSel);
    card.append(top);

    card.append(el('h3', { className: 'title', text: item.title || '(untitled)' }));

    // meta line: branch, checkpoint age, attention signals, then live git/PR facts
    const meta = el('div', { className: 'meta' });
    if (item.branch) meta.append(el('span', { className: 'meta-item', title: 'Branch' }, icon('branch', 13), item.branch));
    const cp = age(item.lastCheckpoint);
    meta.append(el('span', { className: 'meta-item', title: item.lastCheckpoint || '' }, icon('clock', 13), cp ? `Checkpoint ${cp}` : 'Never checkpointed'));
    if (item.sessionsSinceCheckpoint > 0) {
      meta.append(el('span', { className: 'meta-item amber', title: 'Sessions ended since the last /checkpoint' },
        `${plural(item.sessionsSinceCheckpoint, 'session')} since checkpoint`));
    }
    if (item.openSessions > 1) {
      meta.append(el('span', { className: 'meta-item amber', title: 'Sessions or forks with unfinished work' }, icon('threads', 13), `${item.openSessions} open threads`));
    }
    const liveBox = el('span', { className: 'live-facts', 'data-key': item.key });
    meta.append(liveBox);
    card.append(meta);
    if (item.cwd) {
      if (observer) { liveTargets.set(meta, liveBox); observer.observe(meta); } else requestLive(item.key, liveBox);
    }

    // waiting on: shown for waiting items, or whenever something is recorded
    if (item.status === 'waiting' || item.waitingOn) {
      const waiting = el('input', { type: 'text', placeholder: 'What is this waiting on?', 'aria-label': 'Waiting on', maxlength: '500' });
      waiting.value = item.waitingOn || '';
      const saveWaiting = async () => {
        const v = waiting.value.trim();
        if (v === (item.waitingOn || '')) return;
        const r = await mutate('PATCH', itemUrl(item.key), { rev: item.rev, waitingOn: v });
        if (r) replaceItem(r);
      };
      waiting.addEventListener('keydown', (e) => { if (e.key === 'Enter') waiting.blur(); });
      waiting.addEventListener('blur', () => { saveWaiting().finally(flushRender); });
      card.append(el('div', { className: 'waiting' }, el('span', { className: 'waiting-label', text: 'Waiting on' }), waiting));
    }

    if (item.summary) {
      const full = state.expandedSummary.has(item.key);
      const p = el('p', { className: `summary${full ? '' : ' clamped'}`, text: item.summary });
      card.append(p);
      const more = el('button', {
        type: 'button',
        className: 'more-link',
        text: full ? 'Show less' : 'Show more',
        onclick: () => {
          if (full) state.expandedSummary.delete(item.key); else state.expandedSummary.add(item.key);
          render();
        },
      });
      more.hidden = true;
      card.append(more);
      requestAnimationFrame(() => { if (full || p.scrollHeight > p.clientHeight + 1) more.hidden = false; });
    }
    if (item.blockers) card.append(el('p', { className: 'blockers' }, icon('alert'), item.blockers));

    // next steps
    const stepsSection = el('section', {});
    stepsSection.append(el('h4', { className: 'section-label', text: 'Next steps' }));
    if ((item.steps || []).length) stepsSection.append(renderSteps(item));
    else stepsSection.append(el('p', { className: 'no-steps' }, 'No next steps yet. Run ', el('code', { text: `/checkpoint ${item.key}` }), ' in a session.'));
    card.append(stepsSection);

    const sessionsEl = renderSessions(item);
    if (sessionsEl) card.append(sessionsEl);

    // footer: start with the selected steps (or all open steps), copy prompt, archive
    const foot = el('div', { className: 'card-foot' });
    const chosen = selectedSteps(item);
    const open = openStepIndices(item);
    const forStart = chosen.length ? chosen : open;
    if (state.config.canStart) {
      foot.append(el('button', {
        type: 'button',
        className: 'btn primary',
        title: item.cwd ? `Opens a new terminal in ${item.cwd}` : 'No working directory recorded for this item',
        disabled: !item.cwd,
        onclick: () => confirmAndStart(item, forStart),
      }, icon('play', 12), chosen.length ? `Start with ${plural(chosen.length, 'step')}` : open.length ? 'Start with all open steps' : 'Start session'));
    }
    if (chosen.length) {
      foot.append(el('button', {
        type: 'button', className: 'btn ghost', text: 'Clear',
        onclick: () => { state.selected.delete(item.key); render(); },
      }));
    } else if (open.length > 1) {
      foot.append(el('span', { className: 'selection-note', text: 'or click steps to pick some' }));
    }
    foot.append(el('span', { className: 'spacer' }));
    foot.append(iconButton('copy', 'Copy the prompt (for pasting into the desktop app)', async () => {
      const r = await api('GET', `${itemUrl(item.key)}/prompt?steps=${forStart.join(',')}`);
      if (r.ok && r.data) copyText(r.data.prompt, 'Prompt');
      else toast((r.data && r.data.error) || 'Could not build prompt');
    }));
    if (item.status !== 'done') {
      foot.append(iconButton('archive', 'Archive (mark as done)', async () => {
        const r = await mutate('PATCH', itemUrl(item.key), { rev: item.rev, status: 'done' });
        if (r) replaceItem(r);
      }));
    }
    card.append(foot);
    return card;
  }

  function sortByUpdated(a, b) {
    return (Date.parse(b.updated || '') || 0) - (Date.parse(a.updated || '') || 0);
  }

  function groupHead(tag, id, label, n) {
    return el(tag, { className: 'group-head' },
      el('span', { className: `group-dot ${id}` }), label, el('span', { className: 'count', text: String(n) }));
  }

  function render() {
    const active = document.activeElement;
    if (active && board.contains(active) && active.tagName === 'INPUT' && active.type === 'text') {
      state.pendingRender = true;
      return;
    }
    state.pendingRender = false;
    const doneDetails = board.querySelector('details.group');
    if (doneDetails) state.doneOpen = doneDetails.open;

    const buckets = { active: [], waiting: [], parked: [], done: [] };
    for (const it of state.items) {
      if (it.parseError) buckets.active.push(it);
      else if (KNOWN.has(it.status)) buckets[it.status].push(it);
      else buckets.active.push(it);
    }

    countsEl.replaceChildren();
    for (const g of GROUPS) {
      if (buckets[g.id].length) countsEl.append(el('span', {}, el('b', { text: String(buckets[g.id].length) }), ` ${g.label.toLowerCase()}`));
    }

    const frag = document.createDocumentFragment();
    if (!state.items.length) {
      frag.append(el('p', { className: 'empty', text: 'Nothing tracked yet. Run /checkpoint in a Claude session to add your first item.' }));
    }
    for (const g of GROUPS) {
      const list = buckets[g.id].sort(sortByUpdated);
      if (!list.length) continue;
      const section = el('section', { className: 'group' }, groupHead('h2', g.id, g.label, list.length));
      const cards = el('div', { className: 'cards' });
      for (const it of list) cards.append(renderCard(it));
      section.append(cards);
      frag.append(section);
    }
    const done = buckets.done.sort(sortByUpdated);
    if (done.length) {
      const details = el('details', { className: 'group' }, groupHead('summary', 'done', 'Done', done.length));
      details.open = state.doneOpen;
      const doneCards = el('div', { className: 'cards' });
      for (const it of done) doneCards.append(renderCard(it));
      details.append(doneCards);
      frag.append(details);
    }
    board.replaceChildren(frag);
  }

  function flushRender() {
    if (state.pendingRender) render();
  }

  function replaceItem(item) {
    const i = state.items.findIndex((x) => x.key === item.key);
    if (i === -1) state.items.push(item); else state.items[i] = item;
    render();
  }

  async function loadItems() {
    const r = await api('GET', '/api/items');
    if (r.ok && r.data) {
      state.items = r.data.items || [];
      render();
    } else {
      toast('Could not load items');
    }
  }

  async function init() {
    const c = await api('GET', '/api/config');
    if (c.ok && c.data) state.config = c.data;
    await loadItems();
    const es = new EventSource('/api/events');
    es.addEventListener('open', () => { connEl.textContent = 'Live'; connEl.classList.add('ok'); });
    es.addEventListener('error', () => { connEl.textContent = 'Reconnecting…'; connEl.classList.remove('ok'); });
    es.addEventListener('changed', () => { state.live.clear(); loadItems(); });
    es.addEventListener('warning', (e) => {
      let msg = 'Live updates interrupted';
      try { msg = JSON.parse(e.data).message || msg; } catch { /* ignore */ }
      toast(msg);
    });
    document.getElementById('refresh').addEventListener('click', () => { state.live.clear(); loadItems(); });
  }

  init().catch(() => toast('Could not reach the Loose Ends server'));
})();
