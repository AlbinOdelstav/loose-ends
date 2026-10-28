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
    deselected: new Map(), // key -> Set of step texts the user unticked
    live: new Map(), // key -> { at, value }
    doneOpen: false,
    showClosed: new Set(), // item keys whose closed sessions are expanded
    pendingRender: false,
  };

  const board = document.getElementById('board');
  const toastEl = document.getElementById('toast');
  const connEl = document.getElementById('conn');

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
    if (days > 21) return { label: 'very stale', cls: 'bad' };
    if (days > 7) return { label: 'stale', cls: 'warn' };
    return null;
  }

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

  function selectedSteps(item) {
    const des = state.deselected.get(item.key) || new Set();
    return (item.steps || []).filter((s) => !s.done && !des.has(s.text)).map((s) => s.index);
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

  function renderLive(target, value) {
    target.replaceChildren();
    const g = value && value.git;
    if (g && g.ok) {
      if (g.branch) target.append(el('span', { className: 'chip', title: 'Current branch', text: `⎇ ${g.branch}` }));
      if (g.dirty) target.append(el('span', { className: 'chip warn', text: `${g.dirty} uncommitted` }));
      else target.append(el('span', { className: 'chip ok', text: 'clean' }));
      if (g.ahead) target.append(el('span', { className: 'chip', text: `↑${g.ahead}` }));
      if (g.behind) target.append(el('span', { className: 'chip', text: `↓${g.behind}` }));
    } else if (g && g.error) {
      target.append(el('span', { className: 'chip', title: 'git', text: `git: ${g.error}` }));
    }
    const pr = value && value.pr;
    if (pr && pr.ok) {
      const label = `PR #${pr.number ?? '?'} ${String(pr.state || '').toLowerCase()}${pr.isDraft ? ' (draft)' : ''}`;
      const chip = el('span', { className: 'chip' });
      if (typeof pr.url === 'string' && pr.url.startsWith('https://')) {
        chip.append(el('a', { href: pr.url, target: '_blank', rel: 'noopener noreferrer', text: label }));
      } else {
        chip.textContent = label;
      }
      target.append(chip);
      const c = pr.checks || {};
      if (c.total) {
        const cls = c.fail ? 'bad' : c.pending ? 'warn' : 'ok';
        target.append(el('span', { className: `chip ${cls}`, text: `checks ${c.pass}/${c.total}${c.fail ? `, ${c.fail} failing` : ''}${c.pending ? `, ${c.pending} pending` : ''}` }));
      }
      if (pr.reviewDecision) target.append(el('span', { className: 'chip', text: pr.reviewDecision.toLowerCase().replace(/_/g, ' ') }));
    }
  }

  let observer = null;
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer.unobserve(e.target);
        requestLive(e.target.dataset.key, e.target);
      }
    }, { rootMargin: '200px' });
  }

  // ---------- rendering ----------
  // Selected ordered steps whose earlier (not done) steps in the same sequence aren't selected.
  function dependencyWarnings(item, selected) {
    const sel = new Set(selected);
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
        out.push(`Step ${s.seq}${where} ("${s.text}") depends on step ${blocker.seq} ("${blocker.text}"), which isn't selected.`);
      }
    }
    return out;
  }

  function renderWarnings(box, warnings) {
    box.replaceChildren(...warnings.map((w) => el('div', { text: `⚠ ${w}` })));
    box.hidden = warnings.length === 0;
  }

  // Next steps grouped by track. Ordered steps show their number; the next reachable step of each
  // ordered sequence gets a "next" chip and later ones are dimmed (still selectable).
  function renderSteps(item) {
    const wrap = el('div', { className: 'steps-wrap' });
    const des = state.deselected.get(item.key) || new Set();
    const steps = item.steps || [];
    const tracks = item.tracks && item.tracks.length ? item.tracks : [{ name: null, steps: steps.map((s) => s.index) }];
    const showTracks = tracks.length > 1 || tracks.some((t) => t.name !== null);
    const byIndex = new Map(steps.map((s) => [s.index, s]));
    const warnBox = el('div', { className: 'dep-warning', role: 'status' });
    const refreshWarnings = () => renderWarnings(warnBox, dependencyWarnings(item, selectedSteps(item)));

    for (const t of tracks) {
      if (showTracks) wrap.append(el('div', { className: 'track-title', text: t.name === null ? 'General' : t.name }));
      const list = el('ul', { className: 'steps' });
      for (const idx of t.steps) {
        const s = byIndex.get(idx);
        if (!s) continue;
        const id = `step-${item.key}-${s.index}`;
        const cls = ['step'];
        if (s.done) cls.push('done');
        if (s.ordered && !s.done && !s.isNext) cls.push('later');
        const li = el('li', { className: cls.join(' ') });
        const box = el('input', { type: 'checkbox', id, title: s.done ? 'Done' : 'Include in next session' });
        if (s.done) {
          box.checked = true;
          box.disabled = true;
        } else {
          box.checked = !des.has(s.text);
          box.addEventListener('change', () => {
            const set = state.deselected.get(item.key) || new Set();
            if (box.checked) set.delete(s.text); else set.add(s.text);
            state.deselected.set(item.key, set);
            refreshWarnings();
          });
        }
        const label = el('label', { for: id });
        if (s.ordered) label.append(el('span', { className: 'step-num', text: `${s.seq}.` }));
        label.append(document.createTextNode(s.text));
        if (s.isNext) label.append(el('span', { className: 'chip next', text: 'next' }));
        if (s.ordered && !s.done && !s.isNext) label.title = 'Comes after earlier steps in this sequence';
        const toggle = el('button', {
          type: 'button',
          className: 'btn done-toggle',
          title: s.done ? 'Mark as not done' : 'Mark as done',
          text: s.done ? 'undo' : 'done',
          onclick: async () => {
            const r = await mutate('PUT', `${itemUrl(item.key)}/steps/${s.index}`, { rev: item.rev, done: !s.done });
            if (r) replaceItem(r);
          },
        });
        li.append(box, label, toggle);
        list.append(li);
      }
      wrap.append(list);
    }
    wrap.append(warnBox);
    refreshWarnings();
    return wrap;
  }

  // Same rule as SESSION_ID_RE in lib/keys.mjs (this file is a plain browser script).
  const SESSION_ID_RE = /^[A-Za-z0-9-]{1,100}$/;
  const RECENT_UNTRACKED = 3;

  // Session tree. open: true = open thread, false = finished, null = untracked (never classified).
  // Open threads are always shown; the most recent untracked sessions are shown dimmed; finished
  // and older untracked sessions are behind a "N more" toggle. When a parent row is hidden, its
  // visible children move up a level so they never look orphaned.
  function renderSessions(item) {
    const all = [];
    const collect = (nodes) => (nodes || []).forEach((n) => { all.push(n); collect(n.children); });
    collect(item.sessionTree);
    if (!all.length) return null;
    const order = new Map((item.sessions || []).map((s, i) => [s.id, i]));
    const untracked = all.filter((n) => n.open !== true && n.open !== false)
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const recentUntracked = new Set(untracked.slice(-RECENT_UNTRACKED));
    const expanded = state.showClosed.has(item.key);
    const isDefaultVisible = (n) => n.open === true || recentUntracked.has(n);
    const hiddenCount = all.filter((n) => !isDefaultVisible(n)).length;

    const box = el('div', { className: 'sessions' }, el('div', { className: 'sessions-title muted', text: 'Sessions' }));
    const list = el('ul', { className: 'session-list' });
    const renderNode = (node, depth) => {
      const visible = expanded || isDefaultVisible(node);
      if (visible) list.append(renderSessionRow(item, node, depth));
      for (const c of node.children || []) renderNode(c, visible ? depth + 1 : depth);
    };
    for (const root of item.sessionTree || []) renderNode(root, 0);
    box.append(list);
    if (hiddenCount) {
      box.append(el('button', {
        type: 'button',
        className: 'btn small linkish',
        text: expanded ? `Hide ${hiddenCount} finished/older` : `${hiddenCount} more (finished/older)`,
        onclick: () => {
          if (expanded) state.showClosed.delete(item.key); else state.showClosed.add(item.key);
          render();
        },
      }));
    }
    return box;
  }

  function renderSessionRow(item, node, depth) {
    const stateCls = node.open === true ? 'open' : node.open === false ? 'closed' : 'untracked';
    const li = el('li', { className: `session ${stateCls}` });
    li.style.paddingLeft = `${Math.min(depth, 6) * 16}px`;
    const validId = typeof node.id === 'string' && SESSION_ID_RE.test(node.id);
    const head = el('div', { className: 'session-head' },
      el('span', { className: 'session-id', title: node.id || '', text: (depth ? '↳ ' : '') + (node.id ? node.id.slice(0, 8) : '(no id)') }));
    if (node.open === true) head.append(el('span', { className: 'chip warn', text: 'open thread' }));
    else if (node.open === false) head.append(el('span', { className: 'chip', text: 'finished' }));
    if (node.branch) head.append(el('span', { className: 'chip', text: node.branch }));
    const ended = age(node.endedAt);
    if (ended) head.append(el('span', { className: 'muted', text: `ended ${ended}` }));
    if (validId) {
      const next = node.open === true ? false : true;
      const label = node.open === true ? 'Mark finished' : node.open === false ? 'Reopen' : 'Mark open thread';
      head.append(el('button', {
        type: 'button',
        className: 'btn small',
        text: label,
        onclick: async () => {
          const r = await mutate('PATCH', `${itemUrl(item.key)}/sessions/${encodeURIComponent(node.id)}`, { rev: item.rev, open: next });
          if (r) replaceItem(r);
        },
      }));
      head.append(el('button', {
        type: 'button',
        className: 'btn small',
        title: node.cwd ? `Run this in ${node.cwd}` : 'Run this in the session working directory',
        text: 'Copy resume command',
        onclick: () => copyText(`claude --resume ${node.id}`, 'Resume command'),
      }));
    }
    li.append(head);
    if (node.note) li.append(el('div', { className: 'session-note', text: node.note }));
    return li;
  }

  // Shows the exact prompt (as the server will build it) and asks before launching.
  async function confirmAndStart(item) {
    const steps = selectedSteps(item);
    const r = await api('GET', `${itemUrl(item.key)}/prompt?steps=${steps.join(',')}`);
    if (!r.ok || !r.data) {
      toast((r.data && r.data.error) || 'Could not build prompt');
      return;
    }
    const dialog = el('dialog', { className: 'confirm', 'aria-label': 'Start session' });
    const pre = el('pre', { className: 'prompt-preview', text: r.data.prompt });
    const depBox = el('div', { className: 'dep-warning' });
    renderWarnings(depBox, dependencyWarnings(item, steps));
    const launchBtn = el('button', { type: 'button', className: 'btn primary', text: 'Launch' });
    const cancelBtn = el('button', { type: 'button', className: 'btn', text: 'Cancel' });
    dialog.append(
      el('h2', { text: `Start a Claude session for ${item.key}` }),
      el('p', { className: 'muted', text: `A new terminal opens in ${item.cwd || '(no working directory)'} and claude starts with this prompt. Check it before launching.` }),
      depBox,
      pre,
      el('div', { className: 'actions' }, launchBtn, cancelBtn),
    );
    const close = () => { try { dialog.close(); } catch { /* ignore */ } dialog.remove(); };
    cancelBtn.addEventListener('click', close);
    dialog.addEventListener('cancel', close);
    launchBtn.addEventListener('click', async () => {
      launchBtn.disabled = true;
      const res = await mutate('POST', `${itemUrl(item.key)}/start`, { rev: item.rev, steps });
      close();
      if (res) toast(`Session started (${res.via})`);
    });
    document.body.append(dialog);
    dialog.showModal();
    cancelBtn.focus();
  }

  function renderCard(item) {
    if (item.parseError) {
      return el('article', { className: 'card error' },
        el('div', { className: 'card-head' },
          el('span', { className: 'key', text: item.key }),
          el('span', { className: 'chip bad', text: '⚠ unreadable' })),
        el('div', { className: 'blockers', text: `Could not read this item: ${item.parseError}` }));
    }
    const card = el('article', { className: 'card' });

    const keyEl = el('span', { className: 'key' });
    if (item.jiraUrl && /^https?:\/\//.test(item.jiraUrl)) {
      keyEl.append(el('a', { href: item.jiraUrl, target: '_blank', rel: 'noopener noreferrer', text: item.key }));
    } else {
      keyEl.textContent = item.key;
    }
    const head = el('div', { className: 'card-head' }, keyEl);
    if (!KNOWN.has(item.status)) head.append(el('span', { className: 'chip warn', text: `status: ${item.status}` }));
    if (item.jiraStatus) head.append(el('span', { className: 'chip', title: 'Jira status at last checkpoint', text: item.jiraStatus }));
    if (item.parseWarnings && item.parseWarnings.length) {
      head.append(el('span', {
        className: 'chip bad',
        title: `${item.parseWarnings.join('\n')}\nFix the item file by hand or run /checkpoint again.`,
        text: `⚠ ${item.parseWarnings.length} field${item.parseWarnings.length === 1 ? '' : 's'} unreadable`,
      }));
    }
    if (item.sessionsSinceCheckpoint > 0) {
      const n = item.sessionsSinceCheckpoint;
      head.append(el('span', { className: 'chip warn', text: `${n} session${n === 1 ? '' : 's'} since last checkpoint` }));
    }
    if (item.openSessions > 1) {
      head.append(el('span', { className: 'chip warn', title: 'Sessions or forks with unfinished work', text: `${item.openSessions} open threads` }));
    }
    const fresh = freshness(item);
    if (fresh) head.append(el('span', { className: `chip ${fresh.cls}`, text: fresh.label }));
    head.append(el('div', { className: 'title', text: item.title || '(untitled)' }));
    card.append(head);

    // status + waiting on
    const sel = el('select', { 'aria-label': 'Status' });
    const statuses = KNOWN.has(item.status) ? ['active', 'waiting', 'parked', 'done'] : [item.status, 'active', 'waiting', 'parked', 'done'];
    for (const s of statuses) sel.append(el('option', { value: s, text: s }));
    sel.value = item.status;
    sel.addEventListener('change', async () => {
      const r = await mutate('PATCH', itemUrl(item.key), { rev: item.rev, status: sel.value });
      if (r) replaceItem(r); else render();
    });
    const waiting = el('input', { type: 'text', placeholder: 'Waiting on…', 'aria-label': 'Waiting on', maxlength: '500' });
    waiting.value = item.waitingOn || '';
    const saveWaiting = async () => {
      const v = waiting.value.trim();
      if (v === (item.waitingOn || '')) return;
      const r = await mutate('PATCH', itemUrl(item.key), { rev: item.rev, waitingOn: v });
      if (r) replaceItem(r);
    };
    waiting.addEventListener('keydown', (e) => { if (e.key === 'Enter') waiting.blur(); });
    waiting.addEventListener('blur', () => { saveWaiting().finally(flushRender); });
    card.append(el('div', { className: 'row' }, sel, waiting));

    // meta
    const meta = el('div', { className: 'row muted' });
    if (item.branch) meta.append(el('span', { text: `branch: ${item.branch}` }));
    const cp = age(item.lastCheckpoint);
    meta.append(el('span', { text: cp ? `checkpoint ${cp}` : 'never checkpointed' }));
    const up = age(item.updated);
    if (up) meta.append(el('span', { text: `updated ${up}` }));
    card.append(meta);

    if (item.summary) card.append(el('p', { className: 'summary', text: item.summary }));
    if (item.blockers) card.append(el('p', { className: 'blockers', text: item.blockers }));

    const liveBox = el('div', { className: 'row live', 'data-key': item.key });
    card.append(liveBox);
    if (item.cwd) {
      if (observer) observer.observe(liveBox); else requestLive(item.key, liveBox);
    }

    if ((item.steps || []).length) card.append(renderSteps(item));
    else card.append(el('div', { className: 'muted', text: 'No next steps recorded. Run /checkpoint in a session.' }));

    const sessionsEl = renderSessions(item);
    if (sessionsEl) card.append(sessionsEl);

    const actions = el('div', { className: 'actions' });
    const openSteps = (item.steps || []).filter((s) => !s.done).length;
    if (state.config.canStart) {
      actions.append(el('button', {
        type: 'button',
        className: 'btn primary',
        title: item.cwd ? `Opens a new terminal in ${item.cwd}` : 'No working directory recorded for this item',
        disabled: !item.cwd,
        text: openSteps ? 'Start session with selected steps' : 'Start session',
        onclick: () => confirmAndStart(item),
      }));
    }
    actions.append(el('button', {
      type: 'button',
      className: 'btn',
      text: 'Copy prompt',
      onclick: async () => {
        const r = await api('GET', `${itemUrl(item.key)}/prompt?steps=${selectedSteps(item).join(',')}`);
        if (r.ok && r.data) copyText(r.data.prompt, 'Prompt');
        else toast((r.data && r.data.error) || 'Could not build prompt');
      },
    }));
    if (item.status !== 'done') {
      actions.append(el('button', {
        type: 'button',
        className: 'btn',
        text: 'Archive',
        onclick: async () => {
          const r = await mutate('PATCH', itemUrl(item.key), { rev: item.rev, status: 'done' });
          if (r) replaceItem(r);
        },
      }));
    }
    card.append(actions);
    return card;
  }

  function sortByUpdated(a, b) {
    return (Date.parse(b.updated || '') || 0) - (Date.parse(a.updated || '') || 0);
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
    const frag = document.createDocumentFragment();
    for (const g of GROUPS) {
      const list = buckets[g.id].sort(sortByUpdated);
      const section = el('section', { className: 'group' }, el('h2', { text: `${g.label} (${list.length})` }));
      const cards = el('div', { className: 'cards' });
      if (!list.length) cards.append(el('p', { className: 'empty', text: 'Nothing here.' }));
      for (const it of list) cards.append(renderCard(it));
      section.append(cards);
      frag.append(section);
    }
    const done = buckets.done.sort(sortByUpdated);
    const details = el('details', { className: 'group' }, el('summary', { text: `Done (${done.length})` }));
    details.open = state.doneOpen;
    const doneCards = el('div', { className: 'cards' });
    for (const it of done) doneCards.append(renderCard(it));
    details.append(doneCards);
    frag.append(details);
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
    es.addEventListener('open', () => { connEl.textContent = 'live'; connEl.classList.add('ok'); });
    es.addEventListener('error', () => { connEl.textContent = 'reconnecting…'; connEl.classList.remove('ok'); });
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
