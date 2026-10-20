// Kinetic Flow Planner: Gantt chart front end.
(() => {
  'use strict';

  const DAY = 86400000;
  const ZOOMS = { day: 32, week: 14, month: 4 };
  const PAD = { day: [7, 21], week: [14, 56], month: [31, 120] };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const STATUS_LABEL = { not_started: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem('g88.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('g88.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const state = {
    user: null,
    tasks: [],
    users: [],
    zoom: store.get('zoom', 'week'),
    group: store.get('group', true),
    showDone: store.get('done', true),
    owner: store.get('owner', ''),
    scrolledToToday: false,
  };
  if (!ZOOMS[state.zoom]) state.zoom = 'week';

  // ---- Dates (whole days, UTC) ---------------------------------------------------
  const toDay = (s) => Math.round(Date.parse(s + 'T00:00:00Z') / DAY);
  const fromDay = (n) => new Date(n * DAY).toISOString().slice(0, 10);
  const todayDay = () => { const d = new Date(); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY); };
  const dow = (n) => new Date(n * DAY).getUTCDay(); // 0 Sunday
  const short = (n) => { const d = new Date(n * DAY); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; };
  // "12–19 Oct", "28 Oct–4 Nov", or one date for a milestone.
  function dateSpan(s, e, single) {
    if (single || s === e) return short(s);
    const a = new Date(s * DAY), b = new Date(e * DAY);
    return a.getUTCMonth() === b.getUTCMonth() ? `${a.getUTCDate()}–${short(e)}` : `${short(s)}–${short(e)}`;
  }

  // ---- API ----------------------------------------------------------------------
  async function api(path, method = 'GET', body) {
    const res = await fetch('api/' + path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'gant88' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && path !== 'login' && path !== 'password') { showLogin(); throw new Error(data.error || 'Please sign in.'); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  let toastTimer;
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2200);
  }

  function formError(form, msg) {
    const p = $('.form-error', form);
    p.textContent = msg || '';
    p.hidden = !msg;
  }

  // ---- Views ----------------------------------------------------------------------
  function showLogin() {
    state.user = null;
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    setTimeout(() => $('#login-form [name=email]').focus(), 0);
  }

  async function showApp(user) {
    state.user = user;
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#who').textContent = user.name || user.email;
    await Promise.all([loadTasks(), loadUsers()]);
  }

  async function loadTasks() {
    const { tasks } = await api('tasks');
    state.tasks = tasks;
    render();
  }

  async function loadUsers() {
    try { state.users = (await api('users')).users; } catch { state.users = []; }
    fillLists();
  }

  // ---- Which rows to show ---------------------------------------------------------
  function visibleRows() {
    let tasks = state.tasks.slice().sort((a, b) => a.sort_order - b.sort_order || a.start_date.localeCompare(b.start_date) || a.id - b.id);
    if (state.owner) tasks = tasks.filter((t) => t.owner === state.owner);
    if (!state.showDone) tasks = tasks.filter((t) => t.status !== 'done');
    if (!state.group) return tasks.map((t) => ({ type: 'task', task: t }));
    const groups = new Map();
    for (const t of tasks) {
      const key = t.area || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
    const rows = [];
    for (const k of keys) {
      rows.push({ type: 'area', name: k || 'No area', count: groups.get(k).length });
      for (const t of groups.get(k)) rows.push({ type: 'task', task: t });
    }
    return rows;
  }

  // ---- Render ---------------------------------------------------------------------
  function range(tasks) {
    const today = todayDay();
    let lo = today, hi = today + 30;
    for (const t of tasks) { lo = Math.min(lo, toDay(t.start_date)); hi = Math.max(hi, toDay(t.end_date)); }
    const [before, after] = PAD[state.zoom];
    lo -= before; hi += after;
    if (state.zoom === 'week') lo -= (dow(lo) + 6) % 7; // back to Monday
    if (state.zoom === 'month') { const d = new Date(lo * DAY); lo = Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY); }
    return { origin: lo, days: hi - lo + 1 };
  }

  function render() {
    const g = $('#gantt');
    const keepLeft = g.scrollLeft, keepTop = g.scrollTop;
    const rows = visibleRows();
    const px = ZOOMS[state.zoom];
    const { origin, days } = range(state.tasks);
    const W = days * px;
    const listW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--list'), 10) || 340;
    const rowH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row'), 10) || 40;
    const today = todayDay();
    state.geo = { px, origin, listW, rowH };

    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.zoom === state.zoom)));
    $('#empty').hidden = state.tasks.length > 0;
    g.hidden = state.tasks.length === 0;
    updateSummary();
    if (!state.tasks.length) return;

    const inner = el('div', 'g-inner');
    inner.style.width = listW + W + 'px';

    // Header
    const head = el('div', 'g-row g-head');
    head.append(el('div', 'g-name', 'Task'));
    const ht = el('div', 'g-track');
    ht.style.width = W + 'px';
    const scale = el('div', 'scale');
    for (let i = 0; i < days;) {
      const d = new Date((origin + i) * DAY);
      const len = Math.min(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).getTime() / DAY - (origin + i), days - i);
      const m = el('div', 'm', MONTHS[d.getUTCMonth()] + (len * px > 60 ? ' ' + d.getUTCFullYear() : ''));
      m.style.left = i * px + 'px'; m.style.width = len * px + 'px';
      scale.append(m);
      i += len;
    }
    for (let i = 0; i < days; i++) {
      const n = origin + i;
      if (state.zoom === 'day') {
        const c = el('div', 'd' + (dow(n) % 6 === 0 ? ' we' : '') + (n === today ? ' now' : ''), String(new Date(n * DAY).getUTCDate()));
        c.style.left = i * px + 'px'; c.style.width = px + 'px';
        scale.append(c);
      } else if (state.zoom === 'week' && dow(n) === 1) {
        const c = el('div', 'd', short(n));
        c.style.left = i * px + 'px'; c.style.width = 7 * px + 'px';
        scale.append(c);
      }
    }
    ht.append(scale);
    head.append(ht);
    inner.append(head);

    // Background stripes
    const bg = el('div', 'bg');
    bg.style.left = listW + 'px'; bg.style.width = W + 'px';
    for (let i = 0; i < days; i++) {
      const n = origin + i;
      let cls = null;
      if (state.zoom !== 'month' && dow(n) % 6 === 0) cls = 'we';
      else if (state.zoom === 'week' && dow(n) === 1) cls = 'ln';
      else if (state.zoom === 'month' && new Date(n * DAY).getUTCDate() === 1) cls = 'ln';
      if (!cls) continue;
      const s = el('i', cls);
      s.style.left = i * px + 'px';
      if (cls === 'we') s.style.width = px + 'px';
      bg.append(s);
    }
    inner.append(bg);

    // Rows
    const rowIndex = new Map();
    rows.forEach((r, idx) => {
      const row = el('div', 'g-row');
      const name = el('div', 'g-name');
      const track = el('div', 'g-track');
      track.style.width = W + 'px';
      if (r.type === 'area') {
        row.classList.add('area');
        name.append(el('span', 't-title', r.name), el('span', 'area-count', String(r.count)));
      } else {
        const t = r.task;
        rowIndex.set(t.id, idx);
        row.classList.add('task');
        if (t.status === 'done') row.classList.add('done');
        row.dataset.id = t.id;
        name.tabIndex = 0;
        name.setAttribute('role', 'button');
        name.setAttribute('aria-label', `${t.title}, ${STATUS_LABEL[t.status]}, ${short(toDay(t.start_date))} to ${short(toDay(t.end_date))}`);
        const dates = dateSpan(toDay(t.start_date), toDay(t.end_date), t.is_milestone);
        name.append(el('span', 'dot st-' + t.status), el('span', 't-title', t.title));
        if (t.owner) name.append(el('span', 't-owner', t.owner));
        name.append(el('span', 't-dates', dates));
        track.append(...makeBar(t));
      }
      row.append(name, track);
      inner.append(row);
    });

    // Today line
    if (today >= origin && today < origin + days) {
      const line = el('div', 'today-line');
      line.style.left = listW + (today - origin) * px + px / 2 + 'px';
      inner.append(line);
    }

    // Dependency arrows
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'arrows');
    svg.setAttribute('width', W); svg.setAttribute('height', rows.length * rowH);
    svg.style.left = listW + 'px';
    for (const r of rows) {
      if (r.type !== 'task' || !r.task.depends_on || !rowIndex.has(r.task.depends_on)) continue;
      const t = r.task;
      const dep = state.tasks.find((x) => x.id === t.depends_on);
      const x1 = (toDay(dep.end_date) - origin + 1) * px + (dep.is_milestone ? -px / 2 + 9 : 0);
      const y1 = rowIndex.get(dep.id) * rowH + rowH / 2;
      const x2 = (toDay(t.start_date) - origin) * px + (t.is_milestone ? px / 2 - 12 : 0);
      const y2 = rowIndex.get(t.id) * rowH + rowH / 2;
      const dir = y2 > y1 ? 1 : -1;
      const d = x2 - 8 >= x1 + 8
        ? `M${x1} ${y1} H${x1 + 8} V${y2} H${x2}`
        : `M${x1} ${y1} H${x1 + 8} V${y1 + dir * rowH / 2} H${x2 - 10} V${y2} H${x2}`;
      const bad = toDay(t.start_date) <= toDay(dep.end_date);
      for (const p of [d, `M${x2 - 5} ${y2 - 4} L${x2} ${y2} L${x2 - 5} ${y2 + 4}`]) {
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', p);
        if (bad) path.setAttribute('class', 'bad');
        svg.append(path);
      }
    }
    inner.append(svg);

    g.replaceChildren(inner);
    if (!state.scrolledToToday) { scrollToToday(); state.scrolledToToday = true; }
    else { g.scrollLeft = keepLeft; g.scrollTop = keepTop; }
  }

  function makeBar(t) {
    const { px, origin } = state.geo;
    const s = toDay(t.start_date), e = toDay(t.end_date);
    const bar = el('div', 'gbar st-' + t.status);
    bar.dataset.id = t.id;
    if (t.status !== 'done' && e < todayDay()) bar.classList.add('late');
    if (t.is_milestone) {
      bar.classList.add('ms');
      bar.style.left = (s - origin) * px + px / 2 - 9 + 'px';
    } else {
      bar.style.left = (s - origin) * px + 'px';
      bar.style.width = Math.max((e - s + 1) * px, 6) + 'px';
      const fill = el('div', 'fill');
      fill.style.width = t.progress + '%';
      bar.append(fill, el('i', 'h l'), el('i', 'h r'));
    }
    const label = el('span', 'lbl', t.title + (t.progress && !t.is_milestone && t.status !== 'done' ? ` · ${t.progress}%` : ''));
    if (t.is_milestone) {
      // Kept outside the rotated diamond so the text stays level.
      label.classList.add('ms-lbl');
      label.style.left = (s - origin) * px + px / 2 + 14 + 'px';
    } else bar.append(label);
    bar.title = `${t.title}\n${short(s)} – ${short(e)} · ${STATUS_LABEL[t.status]}${t.owner ? ' · ' + t.owner : ''}`;
    return t.is_milestone ? [bar, label] : [bar];
  }

  function updateSummary() {
    const today = todayDay();
    const total = state.tasks.length;
    const done = state.tasks.filter((t) => t.status === 'done').length;
    const late = state.tasks.filter((t) => t.status !== 'done' && toDay(t.end_date) < today).length;
    const blocked = state.tasks.filter((t) => t.status === 'blocked').length;
    const parts = [`${total} task${total === 1 ? '' : 's'}`, `${done} done`];
    if (late) parts.push(`${late} overdue`);
    if (blocked) parts.push(`${blocked} blocked`);
    $('#summary').textContent = total ? parts.join(' · ') : '';
  }

  function scrollToToday() {
    const g = $('#gantt');
    if (!state.geo) return;
    const { px, origin } = state.geo;
    const x = (todayDay() - origin) * px;
    g.scrollLeft = Math.max(0, x - (g.clientWidth - state.geo.listW) * 0.2);
  }

  function fillLists() {
    const owners = new Set(state.tasks.map((t) => t.owner).filter(Boolean));
    state.users.forEach((u) => { if (u.name) owners.add(u.name); });
    const areas = new Set(state.tasks.map((t) => t.area).filter(Boolean));
    const fill = (id, values) => $(id).replaceChildren(...[...values].sort().map((v) => { const o = el('option'); o.value = v; return o; }));
    fill('#owner-list', owners);
    fill('#area-list', areas);
    const sel = $('#owner-filter');
    const taskOwners = [...new Set(state.tasks.map((t) => t.owner).filter(Boolean))].sort();
    if (state.owner && !taskOwners.includes(state.owner)) taskOwners.push(state.owner);
    sel.replaceChildren(el('option', null, 'Everyone'), ...taskOwners.map((o) => { const op = el('option', null, o); op.value = o; return op; }));
    sel.firstChild.value = '';
    sel.value = state.owner;
  }

  // ---- Dragging bars --------------------------------------------------------------
  let drag = null;
  const tip = el('div', 'drag-tip'); tip.hidden = true; document.body.append(tip);

  $('#gantt').addEventListener('pointerdown', (ev) => {
    const bar = ev.target.closest('.gbar');
    if (!bar || ev.button !== 0) return;
    const t = state.tasks.find((x) => x.id === Number(bar.dataset.id));
    if (!t) return;
    const mode = ev.target.classList.contains('l') ? 'start' : ev.target.classList.contains('r') ? 'end' : 'move';
    drag = { bar, t, mode, x0: ev.clientX, s0: toDay(t.start_date), e0: toDay(t.end_date), ds: 0, de: 0, moved: false };
    bar.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  $('#gantt').addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const { px, origin } = state.geo;
    const delta = Math.round((ev.clientX - drag.x0) / px);
    if (!drag.moved && Math.abs(ev.clientX - drag.x0) < 4) return;
    drag.moved = true;
    drag.bar.classList.add('dragging');
    let s = drag.s0, e = drag.e0;
    if (drag.mode === 'move' || drag.t.is_milestone) { s += delta; e += delta; }
    else if (drag.mode === 'start') s = Math.min(drag.s0 + delta, e);
    else e = Math.max(drag.e0 + delta, s);
    drag.ds = s; drag.de = e;
    if (drag.t.is_milestone) drag.bar.style.left = (s - origin) * px + px / 2 - 9 + 'px';
    else { drag.bar.style.left = (s - origin) * px + 'px'; drag.bar.style.width = Math.max((e - s + 1) * px, 6) + 'px'; }
    tip.textContent = drag.t.is_milestone ? short(s) : `${short(s)} – ${short(e)} · ${e - s + 1} day${e === s ? '' : 's'}`;
    tip.style.left = ev.clientX + 12 + 'px'; tip.style.top = ev.clientY - 34 + 'px';
    tip.hidden = false;
  });

  async function endDrag() {
    if (!drag) return;
    const d = drag; drag = null; tip.hidden = true;
    d.bar.classList.remove('dragging');
    if (!d.moved) { openEditor(d.t); return; }
    if (d.ds === d.s0 && d.de === d.e0) return render();
    const patch = { start_date: fromDay(d.ds), end_date: fromDay(d.de) };
    Object.assign(d.t, patch);
    render();
    try {
      const { task } = await api('tasks/' + d.t.id, 'PATCH', patch);
      replaceTask(task);
    } catch (err) {
      toast(err.message, true);
      loadTasks();
    }
  }
  $('#gantt').addEventListener('pointerup', endDrag);
  $('#gantt').addEventListener('pointercancel', () => { if (drag) { drag = null; tip.hidden = true; render(); } });

  $('#gantt').addEventListener('click', (ev) => {
    const name = ev.target.closest('.g-row.task .g-name');
    if (name) openEditor(state.tasks.find((t) => t.id === Number(name.parentElement.dataset.id)));
  });
  $('#gantt').addEventListener('keydown', (ev) => {
    const name = ev.target.closest('.g-row.task .g-name');
    if (name && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); name.click(); }
  });

  function replaceTask(task) {
    const i = state.tasks.findIndex((t) => t.id === task.id);
    if (i >= 0) state.tasks[i] = task; else state.tasks.push(task);
    fillLists();
    render();
  }

  // ---- Task editor ----------------------------------------------------------------
  const dlg = $('#task-dialog');
  const form = $('#task-form');
  let editing = null;

  function openEditor(task) {
    editing = task || null;
    formError(form, '');
    form.reset();
    $('#task-dialog-title').textContent = task ? 'Edit task' : 'Add task';
    $('#delete-task').hidden = !task;
    $('.move', form).hidden = !task;
    const today = todayDay();
    const t = task || {
      title: '', area: state.lastArea || '', owner: state.owner || state.user.name || '', start_date: fromDay(today),
      end_date: fromDay(today + 6), status: 'not_started', progress: 0, is_milestone: false, depends_on: null, notes: '',
    };
    const deps = $('[name=depends_on]', form);
    deps.replaceChildren(el('option', null, 'Nothing'), ...state.tasks
      .filter((x) => !task || x.id !== task.id)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((x) => { const o = el('option', null, `${x.title} (ends ${short(toDay(x.end_date))})`); o.value = x.id; return o; }));
    deps.firstChild.value = '';
    for (const k of ['title', 'area', 'owner', 'start_date', 'end_date', 'status', 'progress', 'notes']) form.elements[k].value = t[k];
    form.elements.is_milestone.checked = t.is_milestone;
    deps.value = t.depends_on || '';
    syncForm();
    $('#task-meta').textContent = task && task.updated_at
      ? `Last changed ${new Date(task.updated_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}${task.updated_by_name || task.updated_by_email ? ' by ' + (task.updated_by_name || task.updated_by_email) : ''}`
      : '';
    dlg.showModal();
    form.elements.title.focus();
  }

  function syncForm() {
    form.elements.progress_out.value = form.elements.progress.value + '%';
    const ms = form.elements.is_milestone.checked;
    form.elements.end_date.disabled = ms;
    if (ms) form.elements.end_date.value = form.elements.start_date.value;
  }
  form.addEventListener('input', (ev) => {
    if (ev.target.name === 'status' && ev.target.value === 'done') form.elements.progress.value = 100;
    if (ev.target.name === 'progress' && Number(ev.target.value) === 100 && form.elements.status.value !== 'done') form.elements.status.value = 'done';
    if (ev.target.name === 'progress' && Number(ev.target.value) > 0 && form.elements.status.value === 'not_started') form.elements.status.value = 'in_progress';
    if (ev.target.name === 'start_date' && form.elements.end_date.value < ev.target.value) form.elements.end_date.value = ev.target.value;
    syncForm();
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = form.elements;
    const body = {
      title: f.title.value.trim(), area: f.area.value.trim(), owner: f.owner.value.trim(),
      start_date: f.start_date.value, end_date: f.is_milestone.checked ? f.start_date.value : f.end_date.value,
      status: f.status.value, progress: Number(f.progress.value), is_milestone: f.is_milestone.checked,
      depends_on: f.depends_on.value ? Number(f.depends_on.value) : null, notes: f.notes.value,
    };
    if (!body.title) return formError(form, 'Give the task a name.');
    if (!body.start_date || !body.end_date) return formError(form, 'Choose a start and end date.');
    if (body.end_date < body.start_date) return formError(form, 'The end date is before the start date.');
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const { task } = editing ? await api('tasks/' + editing.id, 'PATCH', body) : await api('tasks', 'POST', body);
      state.lastArea = body.area;
      dlg.close();
      replaceTask(task);
      toast(editing ? 'Saved' : 'Task added');
    } catch (err) {
      formError(form, err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('#delete-task').addEventListener('click', async () => {
    if (!editing || !confirm(`Delete "${editing.title}"? This can't be undone.`)) return;
    try {
      await api('tasks/' + editing.id, 'DELETE');
      state.tasks = state.tasks.filter((t) => t.id !== editing.id);
      state.tasks.forEach((t) => { if (t.depends_on === editing.id) t.depends_on = null; });
      dlg.close();
      fillLists();
      render();
      toast('Task deleted');
    } catch (err) { formError(form, err.message); }
  });

  async function move(dir) {
    if (!editing) return;
    const all = state.tasks.slice().sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    const same = state.group ? all.filter((t) => (t.area || '') === (editing.area || '')) : all;
    const i = same.findIndex((t) => t.id === editing.id);
    const other = same[i + dir];
    if (!other) return;
    const a = all.indexOf(editing), b = all.indexOf(other);
    [all[a], all[b]] = [all[b], all[a]];
    all.forEach((t, idx) => { t.sort_order = idx + 1; });
    render();
    try { await api('tasks/reorder', 'POST', { ids: all.map((t) => t.id) }); }
    catch (err) { toast(err.message, true); loadTasks(); }
  }
  $('#move-up').addEventListener('click', () => move(-1));
  $('#move-down').addEventListener('click', () => move(1));

  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // ---- Sign in / out, password, team ------------------------------------------------
  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target.elements;
    formError(ev.target, '');
    const btn = $('button', ev.target);
    btn.disabled = true;
    try {
      const { user } = await api('login', 'POST', { email: f.email.value, password: f.password.value });
      f.password.value = '';
      state.scrolledToToday = false;
      await showApp(user);
    } catch (err) {
      formError(ev.target, err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    try { await api('logout', 'POST', {}); } catch { /* signed out anyway */ }
    state.tasks = [];
    showLogin();
  });

  const pwDlg = $('#password-dialog');
  $('#password-btn').addEventListener('click', () => {
    $('#password-form').reset();
    $('#password-form [name=username]').value = state.user.email;
    formError($('#password-form'), '');
    pwDlg.showModal();
  });
  $('#password-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target.elements;
    if (f.next.value.length < 10) return formError(ev.target, 'Use at least 10 characters.');
    try {
      await api('password', 'POST', { current: f.current.value, next: f.next.value });
      pwDlg.close();
      toast('Password changed');
    } catch (err) { formError(ev.target, err.message); }
  });

  const teamDlg = $('#team-dialog');
  function renderTeam() {
    $('#team-list').replaceChildren(...state.users.map((u) => {
      const li = el('li');
      const n = el('div', 'n', u.name || u.email);
      n.append(el('small', null, u.email + (u.last_login_at ? ' · last signed in ' + new Date(u.last_login_at).toLocaleDateString('en-GB') : ' · not signed in yet')));
      li.append(n);
      if (u.id !== state.user.id) {
        const b = el('button', 'btn danger small', 'Remove');
        b.type = 'button';
        b.addEventListener('click', async () => {
          if (!confirm(`Remove ${u.name || u.email}? They won't be able to sign in. Their tasks stay.`)) return;
          try { await api('users/' + u.id, 'DELETE'); await loadUsers(); renderTeam(); }
          catch (err) { toast(err.message, true); }
        });
        li.append(b);
      } else li.append(el('small', 'hint', 'You'));
      return li;
    }));
  }
  $('#team-btn').addEventListener('click', async () => {
    $('#team-form').reset();
    formError($('#team-form'), '');
    await loadUsers();
    renderTeam();
    teamDlg.showModal();
  });
  $('#team-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target.elements;
    try {
      await api('users', 'POST', { name: f.name.value, email: f.email.value, password: f.password.value });
      ev.target.reset();
      formError(ev.target, '');
      await loadUsers();
      renderTeam();
      toast('Added');
    } catch (err) { formError(ev.target, err.message); }
  });

  // ---- Toolbar ------------------------------------------------------------------------
  $('#add-btn').addEventListener('click', () => openEditor(null));
  document.querySelector('[data-action=add]').addEventListener('click', () => openEditor(null));
  $('#today-btn').addEventListener('click', scrollToToday);
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.zoom = b.dataset.zoom; store.set('zoom', state.zoom);
    state.scrolledToToday = false;
    render();
  }));
  $('#group-toggle').checked = state.group;
  $('#done-toggle').checked = state.showDone;
  $('#group-toggle').addEventListener('change', (e) => { state.group = e.target.checked; store.set('group', state.group); render(); });
  $('#done-toggle').addEventListener('change', (e) => { state.showDone = e.target.checked; store.set('done', state.showDone); render(); });
  $('#owner-filter').addEventListener('change', (e) => { state.owner = e.target.value; store.set('owner', state.owner); render(); });

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state.user && render(), 150); });

  // ---- Start ----------------------------------------------------------------------------
  api('me').then(({ user }) => (user ? showApp(user) : showLogin())).catch(showLogin);
})();
