'use strict';

const CATS = [
  ['top', 'Tops', '👕'], ['bottom', 'Bottoms', '👖'], ['dress', 'Dresses', '👗'], ['suit', 'Suits & blazers', '🤵'],
  ['outerwear', 'Outerwear', '🧥'], ['shoes', 'Shoes', '👟'], ['socks', 'Socks', '🧦'], ['accessory', 'Accessories', '👜'],
];
const CAT_LABEL = Object.fromEntries(CATS.map(([k, l]) => [k, l]));
const CAT_ICON = Object.fromEntries(CATS.map(([k, , i]) => [k, i]));
const SINGULAR = { top: 'Top', bottom: 'Bottom', dress: 'Dress / one-piece', suit: 'Suit / blazer', outerwear: 'Outerwear', shoes: 'Shoes', socks: 'Socks', accessory: 'Accessory' };
const OCCASIONS = { 1: 'Casual', 2: 'Smart casual', 3: 'Formal' };
const WARMTH = ['', 'Very light', 'Light', 'Medium', 'Warm', 'Very warm'];
const ORDER = ['outerwear', 'suit', 'top', 'dress', 'bottom', 'shoes', 'socks', 'accessory'];
const kindLabel = (k) => (k ? k[0].toUpperCase() + k.slice(1) : '');
const TITLES = { today: 'Today', closet: 'Closet', history: 'History', outfits: 'Outfits' };

const state = {
  view: 'today', items: [], settings: { unit: 'C' },
  occasion: 2, day: 0, shuffle: 0,
  filter: 'all', kindFilter: '', search: '',
  ai: false, aiResults: null, saved: [], history: [],
  kinds: {}, layerKinds: [], today: [], library: [],
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error("Couldn't reach the closet server. Check your connection.");
  }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).detail; } catch { /* not json */ }
    if (typeof msg !== 'string' || !msg) {
      msg = res.status === 504 || res.status === 502 ? 'The server took too long to answer. Try again.'
        : `Something went wrong (error ${res.status}).`;
    }
    throw new Error(msg);
  }
  return res.json();
}
const sendJSON = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function toast(msg) {
  const t = $('#toast');
  // an open dialog sits above the page, so show the toast inside it
  const host = $$('dialog[open]').pop() || document.body;
  if (t.parentElement !== host) host.appendChild(t);
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- dates & units ----------
function isoDate(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function dayDate(offset) { const d = new Date(); d.setDate(d.getDate() + offset); return isoDate(d); }
function daysAgo(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const then = new Date(y, m - 1, d);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((now - then) / 86400000);
}
function agoText(iso) {
  const d = daysAgo(iso);
  if (d === null) return '';
  if (d <= 0) return d === 0 ? 'today' : 'planned';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}
function dayLabel(iso) {
  const d = daysAgo(iso);
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d === -1) return 'Tomorrow';
  const [y, m, dd] = iso.split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d > 300 ? 'numeric' : undefined });
}
const toDisplay = (c) => (state.settings.unit === 'F' ? c * 9 / 5 + 32 : c);
const fromDisplay = (v) => (state.settings.unit === 'F' ? (v - 32) * 5 / 9 : v);
const fmtT = (c) => (c === null || c === undefined ? '–' : `${Math.round(toDisplay(c))}°`);

// ---------- item visuals ----------
const COLOR_MAP = {
  denim: '#4a6a92', charcoal: '#36454f', cream: '#f3ecd9', camel: '#c19a6b', stone: '#b8b0a2',
  oatmeal: '#d8cdb9', burgundy: '#800020', mustard: '#d6a419', rust: '#b7410e', sage: '#9caf88',
  taupe: '#8b7d6b', offwhite: '#f5f2ea', nude: '#e3bc9a', blush: '#e8b4b8', forest: '#2c5530',
  emerald: '#2a8c5a', mint: '#a8dcc1', lilac: '#c8a2c8', mauve: '#b784a7', cobalt: '#0047ab',
  wine: '#722f37', brown: '#6b4a2f', khaki: '#c3b091', tan: '#c8a77e', beige: '#d9c8a9', grey: '#9a9a9a', gray: '#9a9a9a', patterned: 'repeating-linear-gradient(45deg,#c9bfae 0 8px,#8e8270 8px 16px)',
  navyblue: 'navy', lightblue: 'lightblue', darkgreen: 'darkgreen', olive: '#708238', multi: 'linear-gradient(135deg,#e07a5f,#f2cc8f,#81b29a,#3d405b)',
};
function cssColor(name) {
  const n = (name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!n) return '';
  if (COLOR_MAP[n]) return COLOR_MAP[n];
  if (CSS.supports('color', n)) return n;
  const last = (name || '').toLowerCase().trim().split(/\s+/).pop().replace(/[^a-z]/g, '');
  if (COLOR_MAP[last]) return COLOR_MAP[last];
  if (last && CSS.supports('color', last)) return last;
  return '';
}
function thumb(it, extra = '') {
  if (it.photo_url) return `<div class="thumb ${extra}"><img src="${esc(it.photo_url)}" alt="" loading="lazy"></div>`;
  const c = cssColor(it.color);
  return `<div class="thumb swatch ${extra}" ${c ? `style="--sw:${c}"` : ''}><span>${CAT_ICON[it.category] || '•'}</span></div>`;
}
// "BOSS · Navy oxford shirt": the brand first makes pieces easy to tell apart (names themselves don't change)
function displayName(it) {
  const brand = (it.brand || '').trim();
  const name = it.name || '';
  return brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} · ${name}` : name;
}
const byOrder = (a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || a.name.localeCompare(b.name);

// ---------- navigation ----------
function show(view) {
  state.view = view;
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  $$('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $('#view-title').textContent = TITLES[view];
  render();
  window.scrollTo({ top: 0 });
}
function render() {
  ({ today: renderToday, closet: renderCloset, history: renderHistory, outfits: renderOutfits })[state.view]();
}

function bindSeg(el, onChange) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    $$('button', el).forEach((x) => x.classList.toggle('on', x === b));
    onChange(b.dataset.v);
  });
}
function setSeg(el, v) { $$('button', el).forEach((x) => x.classList.toggle('on', x.dataset.v === String(v))); }
const segValue = (el) => $('button.on', el)?.dataset.v;

// ---------- TODAY ----------
async function renderToday() {
  const box = $('#suggestions');
  box.innerHTML = '<div class="loading">Picking outfits…</div>';
  const params = new URLSearchParams({ occasion: state.occasion, on: dayDate(state.day), seed: state.shuffle });
  let res;
  try {
    res = await api(`/api/recommend?${params}`);
  } catch (e) {
    box.innerHTML = `<div class="card empty">${esc(e.message)}</div>`;
    return;
  }
  renderWeather(res);
  $('#shuffle-btn').hidden = !res.outfits.length;
  if (!res.outfits.length) {
    box.innerHTML = `<div class="card empty"><div>${esc(res.message)}</div><button class="btn primary" id="go-closet">Open closet</button></div>`;
    $('#go-closet').onclick = () => show('closet');
    return;
  }
  state.today = res.outfits;
  box.innerHTML = res.outfits.map((o, i) => todayCard(o, i)).join('');
}

function todayCard(o, i) {
  if (o.rejected) return rejectedPanel(o, 'today', i, o.rejected.reason, false);
  const done = state.day === 0 ? 'Wear this' : 'Plan this';
  const mine = o.source === 'mine';
  const flat = `<div class="card-tools">${tool('flat', '▦ Flat lay', 'today', i)}</div>`;
  const head = mine
    ? `<div class="outfit-head"><div><div class="card-label">From your outfits</div><h3>${esc(o.name || 'Outfit')}</h3>
        <div class="muted small">${esc(statsLine(o))}</div></div>${flat}</div>`
    : `<div class="outfit-head"><div class="card-label idea">${o.kept ? 'New idea · saved ✓' : 'New idea'}</div>${flat}</div>`;
  const decide = !mine && !o.kept
    ? `${tool('reject', '👎', 'today', i, '', 'Not for me')}<button type="button" class="btn" data-act="keep" data-kind="today" data-ref="${i}" title="Save to My outfits without wearing it">Save</button>`
    : '';
  return `
    <article class="card outfit outfit-card" data-kind="today" data-ref="${i}">
      ${head}
      ${piecesHTML(o, 'today', i, true)}
      ${o.notes.length ? `<ul class="notes">${o.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <div class="outfit-actions">${decide}<button class="btn primary" data-wear="${i}">${done}</button></div>
    </article>`;
}

function renderWeather(res) {
  const el = $('#weather-card');
  const s = state.settings;
  el.classList.remove('compact');
  if (s.lat === null || s.lat === undefined) {
    el.classList.add('compact');
    el.innerHTML = `<div><strong>No location set</strong><div class="muted small">Add your city so outfits match the weather.</div></div>
      <button class="btn" id="wx-set">Set location</button>`;
    $('#wx-set').onclick = openSettings;
    return;
  }
  const w = res.weather;
  if (!w) {
    el.innerHTML = `<div><strong>${esc(s.location_name)}</strong><div class="muted small">Weather is unavailable right now, so suggestions assume a mild day.</div></div>`;
    return;
  }
  const rain = w.precip_prob !== null && w.precip_prob !== undefined ? ` · ${w.precip_prob}% chance of rain` : '';
  el.innerHTML = `
    <div class="wx-main">
      <div class="wx-temp">${fmtT(w.temp_max)}<span>${fmtT(w.temp_min)}</span></div>
      <div><strong>${esc(w.summary || 'Forecast')}</strong>
        <div class="muted small">${esc(s.location_name)} · feels like ${fmtT(w.effective)}${rain}</div></div>
    </div>
    ${res.headline ? `<p class="wx-note">${esc(res.headline)}</p>` : ''}`;
}

async function wear(outfit, btn) {
  if (outfit.library_id) { wearLib({ id: outfit.library_id }, btn, dayDate(state.day), state.occasion); return; }
  btn.disabled = true;
  try {
    const r = await api('/api/outfits', sendJSON('POST', {
      item_ids: outfit.items.map((i) => i.id), worn_on: dayDate(state.day), occasion: state.occasion,
    }));
    btn.textContent = 'Logged ✓';
    offerPhoto(btn.closest('.outfit-actions') || btn, r.id);
    toast(state.day === 0 ? 'Logged. Rate it later in History.' : 'Planned for tomorrow.');
    await loadItems();
  } catch (e) {
    btn.disabled = false;
    toast(e.message);
  }
}

// ---------- CLOSET ----------
function renderCloset() {
  const active = state.items.filter((i) => !i.archived);
  const counts = { all: active.length, laundry: active.filter((i) => i.in_laundry).length, archived: state.items.length - active.length };
  CATS.forEach(([k]) => { counts[k] = active.filter((i) => i.category === k).length; });

  const chips = [['all', 'All'], ...CATS.map(([k, l]) => [k, l]), ['laundry', 'Laundry'], ['archived', 'Archived']]
    .filter(([k]) => k === 'all' || counts[k] > 0 || k === state.filter);
  $('#cat-chips').innerHTML = chips.map(([k, l]) =>
    `<button class="chip ${state.filter === k ? 'on' : ''}" data-f="${k}">${l}<span class="n">${counts[k]}</span></button>`).join('');

  const bar = $('#laundry-bar');
  bar.hidden = counts.laundry === 0;
  bar.innerHTML = `<span>${counts.laundry} item${counts.laundry === 1 ? '' : 's'} in the laundry</span><button class="btn" id="all-clean">All clean</button>`;
  const allClean = $('#all-clean');
  if (allClean) allClean.onclick = clearLaundry;

  let list = state.filter === 'archived' ? state.items.filter((i) => i.archived) : active;
  if (state.filter === 'laundry') list = list.filter((i) => i.in_laundry);
  else if (CAT_LABEL[state.filter]) list = list.filter((i) => i.category === state.filter);
  list = filterByKind(list);
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter((i) => [i.name, i.kind, i.color, i.color2, i.brand, i.material, i.pattern, i.tags, i.notes].join(' ').toLowerCase().includes(q));
  list = [...list].sort(byOrder);

  const grid = $('#closet-grid');
  if (!state.items.length) {
    grid.innerHTML = `<div class="card empty" style="grid-column:1/-1">
      <div><strong>Your closet is empty</strong></div>
      <div>Add a few tops, bottoms and shoes and you'll get outfit ideas on the Today tab.</div>
      <div class="inline"><button class="btn primary" id="empty-add">Add your first item</button>
      <button class="btn" id="empty-bulk">Add many at once</button></div></div>`;
    $('#empty-add').onclick = () => openItem();
    $('#empty-bulk').onclick = () => openBulk();
    return;
  }
  if (!list.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Nothing here.</div>';
    return;
  }
  grid.innerHTML = list.map((it) => `
    <div class="item-card ${it.in_laundry ? 'dirty' : ''}" data-id="${it.id}" role="button" tabindex="0">
      ${thumb(it)}
      ${it.archived ? '' : `<button class="laundry-btn ${it.in_laundry ? 'on' : ''}" data-laundry="${it.id}" aria-label="${it.in_laundry ? 'Mark clean' : 'Mark as in laundry'}" title="${it.in_laundry ? 'In laundry: tap when clean' : 'Send to laundry'}">🧺</button>`}
      ${it.favorite ? '<span class="fav" aria-label="Favorite">♥</span>' : ''}
      <div class="item-meta">
        <div class="item-name">${esc(displayName(it))}</div>
        ${it.kind || it.match_id ? `<div class="muted small item-kind">${esc([kindLabel(it.kind), it.match_id ? '🔗 Suit' : ''].filter(Boolean).join(' · '))}</div>` : ''}
        <div class="muted small">${it.times_worn ? `Worn ${it.times_worn}× · ${agoText(it.last_worn)}` : 'Not worn yet'}</div>
      </div>
    </div>`).join('');
}

async function toggleLaundry(id) {
  const it = state.items.find((i) => i.id === id);
  const updated = await api(`/api/items/${id}`, sendJSON('PATCH', { in_laundry: !it.in_laundry }));
  Object.assign(it, updated);
  renderCloset();
}
async function clearLaundry() {
  const r = await api('/api/laundry/clear', { method: 'POST' });
  await loadItems();
  renderCloset();
  toast(`${r.cleared} item${r.cleared === 1 ? '' : 's'} back in rotation`);
}

const PLURAL = { dress: 'Dresses', scarf: 'Scarves', watch: 'Watches', jewelry: 'Jewelry' };
const pluralKind = (k) => PLURAL[k] || (k.endsWith('s') ? kindLabel(k) : `${kindLabel(k)}s`);

// second row of chips: the types within the chosen category (only the ones you own)
function filterByKind(list) {
  const sub = $('#kind-chips');
  if (!CAT_LABEL[state.filter]) {
    sub.hidden = true;
    state.kindFilter = '';
    return list;
  }
  const counts = {};
  list.forEach((i) => { const k = i.kind || '_none'; counts[k] = (counts[k] || 0) + 1; });
  const order = [...(state.kinds[state.filter] || []), '_none'].filter((k) => counts[k]);
  if (state.kindFilter && !counts[state.kindFilter]) state.kindFilter = '';
  sub.hidden = order.length < 2;
  sub.innerHTML = [`<button class="chip ${state.kindFilter ? '' : 'on'}" data-k="">All ${esc(CAT_LABEL[state.filter].toLowerCase())}</button>`,
    ...order.map((k) => `<button class="chip ${state.kindFilter === k ? 'on' : ''}" data-k="${esc(k)}">${esc(k === '_none' ? 'No type' : pluralKind(k))}<span class="n">${counts[k]}</span></button>`)].join('');
  return state.kindFilter ? list.filter((i) => (i.kind || '_none') === state.kindFilter) : list;
}

// ---------- item editor ----------
let editing = null;
let pendingPhoto = null;
let removePhoto = false;

function setPreview(url) {
  const p = $('#photo-preview');
  p.classList.toggle('has', !!url);
  p.innerHTML = url ? `<img src="${esc(url)}" alt="">` : '<span>Add photo</span>';
  $('#remove-photo-btn').hidden = !url;
}

function updateKindOptions(want) {
  const f = $('#item-form');
  const opts = state.kinds[f.category.value] || [];
  const cur = want === undefined ? f.kind.value : want;
  f.kind.innerHTML = '<option value="">–</option>' + opts.map((k) => `<option value="${esc(k)}">${esc(kindLabel(k))}</option>`).join('');
  f.kind.value = opts.includes(cur) ? cur : '';
  updateSuitBox();
}

function updateSuitBox(want) {
  const f = $('#item-form');
  const cat = f.category.value;
  const other = { suit: 'bottom', bottom: 'suit' }[cat];
  $('#suit-box').hidden = !other;
  if (!other) { f.match_id.value = ''; return; }
  const cur = want === undefined ? f.match_id.value : String(want ?? '');
  const options = state.items
    .filter((i) => i.category === other && !i.archived && i.id !== editing?.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  const taken = (i) => (i.match_id && i.match_id !== editing?.id ? ` (now with ${state.items.find((x) => x.id === i.match_id)?.name || 'another'})` : '');
  f.match_id.innerHTML = `<option value="">${cat === 'suit' ? 'Not part of a suit' : 'No matching jacket'}</option>`
    + options.map((i) => `<option value="${i.id}">${esc(i.name + taken(i))}</option>`).join('');
  f.match_id.value = options.some((i) => String(i.id) === cur) ? cur : '';
  $('#match-label').textContent = cat === 'suit' ? 'Matching trousers (makes it a suit)' : 'Matching suit jacket';
  updatePairOnly();
}

function updatePairOnly() {
  const f = $('#item-form');
  const linked = !!f.match_id.value;
  $('#pair-only-check').hidden = !linked;
  if (!linked) f.pair_only.checked = false;
  $('#suit-hint').textContent = !linked
    ? (f.category.value === 'suit' ? 'Pick the trousers that belong to this jacket, if any.' : '')
    : (f.category.value === 'suit'
      ? 'Worn with its trousers it counts as formal; worn alone, one step less formal.'
      : 'Suggested together with the jacket; can also be worn on its own unless you tick the box.');
}

function openItem(it = null) {
  editing = it;
  pendingPhoto = null;
  removePhoto = false;
  const f = $('#item-form');
  f.reset();
  $('#item-dialog-title').textContent = it ? 'Edit item' : 'Add item';
  f.name.value = it?.name || '';
  f.category.value = it?.category || (CAT_LABEL[state.filter] ? state.filter : 'top');
  updateKindOptions(it?.kind || '');
  updateSuitBox(it?.match_id ?? '');
  f.pair_only.checked = !!it?.pair_only;
  updatePairOnly();
  f.color.value = it?.color || '';
  f.warmth.value = it?.warmth || 3;
  $('#warmth-label').textContent = WARMTH[f.warmth.value];
  setSeg($('#formality-seg'), it?.formality || 2);
  f.brand.value = it?.brand || '';
  f.material.value = it?.material || '';
  f.fit.value = it?.fit || '';
  f.pattern.value = it?.pattern || '';
  f.color2.value = it?.color2 || '';
  $('#url-import').hidden = !!it;
  $('#import-url').value = '';
  setImportStatus('');
  $('#cutout-toggle').checked = true;
  hideBrands();
  f.tags.value = it?.tags || '';
  f.notes.value = it?.notes || '';
  f.favorite.checked = !!it?.favorite;
  setPreview(it?.photo_url || null);
  $('#item-extra-actions').hidden = !it;
  if (it) $('#archive-btn').textContent = it.archived ? 'Restore' : 'Archive';
  updateAIButtons();
  $('#item-dialog').showModal();
}

async function saveItem(e) {
  e.preventDefault();
  const f = e.target;
  const fd = new FormData();
  fd.append('name', f.name.value);
  fd.append('category', f.category.value);
  fd.append('color', f.color.value);
  fd.append('warmth', f.warmth.value);
  fd.append('formality', segValue($('#formality-seg')) || 2);
  fd.append('brand', f.brand.value);
  ['kind', 'match_id', 'material', 'fit', 'pattern', 'color2'].forEach((k) => fd.append(k, f[k].value));
  fd.append('pair_only', f.pair_only.checked ? 'true' : 'false');
  fd.append('tags', f.tags.value);
  fd.append('notes', f.notes.value);
  fd.append('favorite', f.favorite.checked ? 'true' : 'false');
  if (pendingPhoto) fd.append('photo', pendingPhoto);
  if (pendingPhoto && state.cutout && $('#cutout-toggle').checked) fd.append('cutout_photo', 'true');
  if (removePhoto && !pendingPhoto) fd.append('remove_photo', 'true');

  const btn = $('#item-save-btn');
  btn.disabled = true;
  try {
    const saved = await api(editing ? `/api/items/${editing.id}` : '/api/items', { method: editing ? 'PUT' : 'POST', body: fd });
    $('#item-dialog').close();
    toast(saved.cutout_error ? `Saved, but the background wasn't removed: ${saved.cutout_error}` : (editing ? 'Saved' : 'Added to your closet'));
    await loadItems();
    render();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function archiveItem() {
  await api(`/api/items/${editing.id}`, sendJSON('PATCH', { archived: !editing.archived }));
  $('#item-dialog').close();
  toast(editing.archived ? 'Restored' : 'Archived. History is kept.');
  await loadItems();
  render();
}
async function deleteItem() {
  if (!confirm(`Delete "${editing.name}" for good? It will also be removed from your outfit history. Archive keeps the history.`)) return;
  await api(`/api/items/${editing.id}`, { method: 'DELETE' });
  $('#item-dialog').close();
  toast('Deleted');
  await loadItems();
  render();
}

// ---------- HISTORY ----------
function starsHTML(rating, attr) {
  return [1, 2, 3, 4, 5].map((n) => `<button type="button" class="${rating >= n ? 'on' : ''}" ${attr}="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('');
}

async function renderHistory() {
  const box = $('#history-list');
  box.innerHTML = '<div class="loading">Loading…</div>';
  const outfits = await api('/api/outfits');
  state.history = outfits;
  if (!outfits.length) {
    box.innerHTML = '<div class="card empty">No outfits logged yet. Tap “Wear this” on the Today tab or log one here.</div>';
    return;
  }
  let html = '';
  let last = null;
  for (const o of outfits) {
    if (o.worn_on !== last) { html += `<div class="day-label">${esc(dayLabel(o.worn_on))}</div>`; last = o.worn_on; }
    html += `
      <article class="card hist" data-outfit="${o.id}" data-kind="history" data-ref="${o.id}">
        <div class="hist-top">
          <div class="stars" aria-label="Rating">${starsHTML(o.rating || 0, 'data-rate')}</div>
          <div><span class="muted small">${esc(OCCASIONS[o.occasion] || '')}</span>
          <button class="icon-btn" data-edit="${o.id}" aria-label="Edit outfit" title="Edit or add a note">✎</button>
          <button class="icon-btn" data-del="${o.id}" aria-label="Delete outfit" title="Delete">✕</button></div>
        </div>
        <div class="hist-items">${o.items.map((it) => thumb(it, 'sm')).join('')}</div>
        ${o.library_name ? `<div class="hist-from">${esc(o.library_name)}</div>` : ''}
        <div class="hist-names">${o.items.map((it) => esc(displayName(it))).join(' · ')}</div>
        ${o.notes ? `<div class="hist-note">${esc(o.notes)}</div>` : ''}
        ${photosHTML(o, 'history', o.id)}
        <div class="card-tools">${state.ai ? tool('check', '🔍 Check my look', 'history', o.id, 'ai') : ''}${tool('flat', '▦ Flat lay', 'history', o.id)}${tool('photo', '📷 Photo', 'history', o.id, '', 'Add your own photo')}</div>
      </article>`;
  }
  box.innerHTML = html;
  bindPhotoDrops(box);
}

// ---------- log outfit ----------
let picked = new Set();
let logRating = 0;
let logEdit = null; // null = new log, {kind: 'history'|'saved', id}

function openLog(outfit = null, kind = 'history') {
  const savedMode = kind === 'lib' || kind === 'lib-new';
  logEdit = outfit ? { kind, id: outfit.id } : (kind === 'lib-new' ? { kind } : null);
  picked = new Set(outfit ? outfit.items.map((i) => i.id) : []);
  logRating = (kind === 'history' && outfit?.rating) || 0;
  const f = $('#log-form');
  $('#log-title').textContent = kind === 'lib-new' ? 'New outfit'
    : (!outfit ? 'Log an outfit' : (savedMode ? 'Edit outfit' : 'Edit worn outfit'));
  $('#log-save-btn').textContent = outfit ? 'Save changes' : 'Save outfit';
  $('#log-name-field').hidden = !savedMode;
  $('#log-date-field').hidden = savedMode;
  $('#log-stars-field').hidden = savedMode;
  f.outfit_name.value = savedMode ? outfit?.name || '' : '';
  $('#name-ai-btn').hidden = !state.ai;
  $('#name-ideas').innerHTML = '';
  f.worn_on.value = outfit?.worn_on || dayDate(0);
  f.occasion.value = String(outfit?.occasion || state.occasion);
  f.notes.value = outfit?.notes || '';
  $('#log-stars').innerHTML = starsHTML(logRating, 'data-star');
  // pieces of this outfit stay pickable even if archived since
  const active = state.items.filter((i) => !i.archived || picked.has(i.id));
  $('#picker').innerHTML = active.length ? CATS.map(([k, label]) => {
    const its = active.filter((i) => i.category === k).sort(byOrder);
    if (!its.length) return '';
    return `<div><h4>${label}</h4><div class="picker-grid">${its.map((it) =>
      `<button type="button" class="pick ${picked.has(it.id) ? 'on' : ''}" data-pick="${it.id}">${thumb(it)}<span>${esc(displayName(it))}</span></button>`).join('')}</div></div>`;
  }).join('') : '<div class="muted">Add items to your closet first.</div>';
  updatePickCount();
  $('#log-dialog').showModal();
}
function updatePickCount() {
  const lib = logEdit && String(logEdit.kind).startsWith('lib');
  $('#pick-count').textContent = picked.size ? `${picked.size} piece${picked.size > 1 ? 's' : ''} selected`
    : (lib ? 'Tap the pieces of this outfit.' : 'Tap the pieces you wore.');
}
async function saveLog(e) {
  e.preventDefault();
  if (!picked.size) { toast('Pick at least one piece'); return; }
  const f = e.target;
  const base = { item_ids: [...picked], occasion: Number(f.occasion.value), notes: f.notes.value };
  try {
    let warnings = [];
    if (logEdit?.kind === 'lib' || logEdit?.kind === 'lib-new') {
      const body = { ...base, name: f.outfit_name.value };
      const r = logEdit.kind === 'lib'
        ? await api(`/api/library/${logEdit.id}`, sendJSON('PUT', body))
        : await api('/api/library', sendJSON('POST', { ...body, status: 'kept', source: 'own' }));
      warnings = r.warnings || [];
      if (logEdit.kind === 'lib-new') libView.tab = 'kept';
      await loadLibrary();
      if (logEdit.kind === 'lib') refreshDetail(logEdit.id);
    } else {
      const body = { ...base, worn_on: f.worn_on.value || dayDate(0), rating: logRating || null };
      await api(logEdit ? `/api/outfits/${logEdit.id}` : '/api/outfits', sendJSON(logEdit ? 'PUT' : 'POST', body));
    }
    $('#log-dialog').close();
    toast(warnings.length ? `Saved. Heads-up: ${warnings.join(' ')}` : (logEdit ? 'Saved' : 'Outfit logged'));
    await loadItems();
    render();
  } catch (err) { toast(err.message); }
}

// ---------- OUTFITS: one list (to review / my outfits / rejected) ----------
const OCC_SHORT = { 1: 'Casual', 2: 'Work', 3: 'Formal' };
const REJECT_REASONS = ['Colors clash', 'Too formal', 'Too casual', 'Don’t like a piece', 'Wrong for the season'];

async function loadLibrary() {
  try { state.library = await api('/api/library'); } catch { state.library = state.library || []; }
  updateLibCounts();
}
function libOf(status) { return (state.library || []).filter((o) => o.status === status); }
function updateLibCounts() {
  ['idea', 'kept', 'rejected'].forEach((s) => { $(`#n-${s}`).textContent = libOf(s).length || ''; });
  $('#outfits-tab').hidden = !(state.ai || (state.library || []).length);
}

function statsLine(o) {
  const bits = [o.times_worn ? `Worn ${o.times_worn}×` : 'Not worn yet'];
  if (o.last_worn) bits.push(o.last_worn > dayDate(0) ? `planned ${dayLabel(o.last_worn)}` : `last ${agoText(o.last_worn)}`);
  if (o.avg_rating) bits.push(`★${o.avg_rating}`);
  if (o.occasion) bits.push(OCC_SHORT[o.occasion]);
  return bits.join(' · ');
}
const SOURCE_LABEL = { ai: 'Made by AI', own: 'Made by you', today: 'From Today' };

function tool(act, label, kind, ref, cls = '', title = '') {
  return `<button type="button" class="tool-btn ${cls}" data-act="${act}" data-kind="${kind}" data-ref="${ref}" ${title ? `title="${title}" aria-label="${title}"` : ''}>${label}</button>`;
}

function piecesHTML(o, kind, ref, tappable) {
  return `<div class="outfit-items">${o.items.map((it) => {
    const inner = `${thumb(it)}<figcaption>${esc(displayName(it))}</figcaption>`;
    const dirty = it.in_laundry || it.archived ? 'dirty' : '';
    return tappable
      ? `<button type="button" class="piece ${dirty}" data-act="piece" data-kind="${kind}" data-ref="${ref}" data-item="${it.id}" title="Details and swap">${inner}</button>`
      : `<figure class="${dirty}">${inner}</figure>`;
  }).join('')}</div>`;
}

function photosHTML(o, kind, ref) {
  if (!o.photos?.length) return '';
  return `<div class="outfit-photos">${o.photos.map((ph) => `<button type="button" class="ph" data-act="view" data-kind="${kind}" data-ref="${ref}" data-photo="${ph.id}" aria-label="${ph.source === 'tryon' ? 'AI try-on picture' : 'Your photo'}">
    <img src="${esc(ph.url)}" alt="" loading="lazy">${ph.source === 'tryon' ? '<span class="badge">AI</span>' : ''}${ph.review ? `<span class="badge score v-${ph.review.verdict}">${ph.review.score}/10</span>` : ''}</button>`).join('')}</div>`;
}

// The picture that stands for an outfit: your latest real photo, else the latest try-on, else none (flat lay).
function coverPhoto(o) {
  const newest = [...(o.photos || [])].reverse();
  return newest.find((p) => p.source === 'own') || newest.find((p) => p.source === 'tryon') || null;
}

function heroHTML(o) {
  const ph = coverPhoto(o);
  if (ph) {
    return `<button type="button" class="hero" data-act="view" data-kind="lib" data-ref="${o.id}" data-photo="${ph.id}"><img src="${esc(ph.url)}" alt="You wearing this outfit"></button>`;
  }
  return `<div class="hero">${flatLayHTML(o.items, false)}</div>`;
}

function coverHTML(o) {
  const ph = coverPhoto(o);
  if (ph) {
    return `<div class="cover"><img src="${esc(ph.url)}" alt="" loading="lazy">${ph.source === 'tryon' ? '<span class="badge">Try-on</span>' : ''}</div>`;
  }
  return `<div class="cover">${flatLayHTML(o.items, false)}</div>`;
}

function coverCard(o) {
  const out = o.items.some((it) => it.in_laundry || it.archived);
  return `<button type="button" class="cover-card outfit-card" data-act="open" data-kind="lib" data-ref="${o.id}">
      ${coverHTML(o)}
      <span class="cover-meta"><strong>${esc(o.name || 'Outfit')}</strong>
        <span class="muted small">${esc(statsLine(o))}${out ? ' · something’s in the wash' : ''}</span></span>
    </button>`;
}

let detailId = null;
function openOutfit(o) {
  detailId = o.id;
  viewerCtx = null;
  const k = 'lib';
  const ref = o.id;
  const tools = [];
  if (state.ai) tools.push(tool('check', '🔍 Check my look', k, ref, 'ai', 'Take a photo wearing it; the AI judges it critically'), tool('tryon', '👤 Try on', k, ref, 'ai'));
  tools.push(tool('photo', '📷 Add photo', k, ref), tool('flat', '▦ Flat lay', k, ref),
    tool('edit', '✎ Edit', k, ref, '', 'Name, note, occasion and pieces'), tool('delete', '🗑', k, ref, '', 'Delete'));
  const cover = heroHTML(o);
  const unavailable = o.items.filter((it) => it.in_laundry || it.archived);
  const body = `<div class="detail outfit-card" data-detail="${ref}" data-kind="lib" data-ref="${ref}">
      ${cover}
      <div class="muted small">${esc(statsLine(o))}</div>
      <div class="rate-row"><span class="muted small">Your rating</span><div class="stars" data-orate-for="${ref}">${starsHTML(o.rating || 0, 'data-orate')}</div></div>
      ${o.notes ? `<div class="outfit-note">${esc(o.notes)}</div>` : ''}
      <div class="card-tools left">${tools.join('')}</div>
      ${piecesHTML(o, k, ref, true)}
      <div class="muted small">Tap a piece for details or to swap it.</div>
      ${unavailable.length ? `<div class="import-status error small">Not available now: ${esc(unavailable.map((i) => i.name).join(', '))}</div>` : ''}
      ${photosHTML(o, k, ref)}
    </div>`;
  const tomorrow = dayDate(1);
  const foot = `<div class="plan-row"><input type="date" id="plan-date" min="${tomorrow}" value="${tomorrow}" aria-label="Plan for">
      <button type="button" class="btn" data-act="plan" data-kind="lib" data-ref="${ref}">Plan</button></div>
    <div class="outfit-actions"><button type="button" class="btn primary" data-act="wear" data-kind="lib" data-ref="${ref}">Wear today</button></div>`;
  openViewer(o.name || 'Outfit', body, foot);
  bindPhotoDrops($('#viewer-body'));
}
function refreshDetail(id) {
  const o = getOutfit('lib', id);
  if (o && $('#viewer').open && detailId === id) openOutfit(o);
}

function chooseCreate() {
  viewerCtx = null;
  detailId = null;
  openViewer('New outfit', `<div class="create-choices">
      ${state.ai ? `<div class="create-opt"><strong>✨ Let AI create outfits</strong>
        <span class="muted small">From your clean clothes, following your rules. They land in “To review”, where you keep the ones you like.</span>
        <input id="create-note" maxlength="300" placeholder="Optional: what for? e.g. work week" autocomplete="off">
        <button type="button" class="btn primary" data-cact="ai">Create with AI</button></div>` : ''}
      <button type="button" class="create-opt" data-cact="own"><strong>👕 Pick the pieces myself</strong>
        <span class="muted small">Choose from your closet and save it to My outfits.</span></button>
    </div>`);
}

function rejectedPanel(o, kind, ref, reason, next) {
  const picked = new Set((reason || '').split('; ').filter(Boolean));
  const free = (reason || '').split('; ').filter((r) => r && !REJECT_REASONS.includes(r)).join('; ');
  return `<article class="card discarded-card outfit-card" data-kind="${kind}" data-ref="${ref}">
      <div><strong>Not for me.</strong> <span class="muted">It won't be suggested again. Why? (optional)</span></div>
      <div class="kind-chips">${REJECT_REASONS.map((r) => `<button type="button" class="chip ${picked.has(r) ? 'on' : ''}" data-act="reason-chip" data-kind="${kind}" data-ref="${ref}">${esc(r)}</button>`).join('')}</div>
      <div class="inline"><input data-reason maxlength="200" placeholder="Or in your own words" value="${esc(free)}">
        <button type="button" class="btn" data-act="reason" data-kind="${kind}" data-ref="${ref}">Save</button></div>
      <div class="outfit-actions"><button type="button" class="btn ghost" data-act="undo" data-kind="${kind}" data-ref="${ref}">Undo</button>
        ${next ? `<button type="button" class="btn primary" data-act="next" data-kind="${kind}" data-ref="${ref}">Next</button>` : ''}</div>
    </article>`;
}

function libCard(o, mode) {
  const k = 'lib';
  const ref = o.id;
  const unavailable = o.items.filter((it) => it.in_laundry || it.archived);
  const notes = [mode === 'review' && o.notes ? o.notes : '',
    unavailable.length ? `Not available now: ${unavailable.map((it) => it.name).join(', ')}` : ''].filter(Boolean);
  const userNote = mode !== 'review' && o.notes ? `<div class="outfit-note">${esc(o.notes)}</div>` : '';
  const sub = mode === 'kept' ? statsLine(o) : (SOURCE_LABEL[o.source] || '');
  const tools = [tool('flat', '▦ Flat lay', k, ref)];
  if (mode !== 'rejected' && state.ai) tools.push(tool('tryon', '👤 Try on', k, ref, 'ai'));
  if (mode === 'kept') tools.push(tool('photo', '📷', k, ref, '', 'Add your own photo'));
  if (mode !== 'rejected') tools.push(tool('edit', '✎', k, ref, '', 'Edit name, note and pieces'));
  if (mode !== 'review') tools.push(tool('delete', '🗑', k, ref, '', 'Delete'));
  let actions;
  if (mode === 'review') {
    actions = `${tool('reject', '👎 Not for me', k, ref)}${tool('later', 'Later', k, ref)}<button type="button" class="btn primary" data-act="keep" data-kind="${k}" data-ref="${ref}">👍 Save</button>`;
  } else if (mode === 'kept') {
    actions = `<button type="button" class="btn primary" data-act="wear" data-kind="${k}" data-ref="${ref}">Wear this</button>`;
  } else {
    actions = `<button type="button" class="btn" data-act="restore" data-kind="${k}" data-ref="${ref}">Back to review</button>`;
  }
  return `
    <article class="card outfit outfit-card" data-kind="${k}" data-ref="${ref}">
      <div class="outfit-head"><div><h3>${esc(o.name || 'Outfit')}</h3>${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}</div>
        <div class="card-tools">${tools.join('')}</div></div>
      ${mode === 'review' ? heroHTML(o) : ''}
      ${piecesHTML(o, k, ref, mode !== 'rejected')}
      ${mode === 'review' ? '<div class="muted small">Tap a piece for details or to swap it.</div>' : ''}
      ${mode === 'kept' ? photosHTML(o, k, ref) : ''}
      ${userNote}
      ${mode === 'rejected' && o.reason ? `<div class="outfit-note">Why not: ${esc(o.reason)}</div>` : ''}
      ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <div class="outfit-actions">${actions}</div>
    </article>`;
}

const libView = { tab: null, occ: 0, season: '', sort: 'rating', reviewHold: null };

function seasonOf(o) {
  const w = o.items.filter((i) => !['accessory', 'socks', 'shoes'].includes(i.category)).map((i) => i.warmth);
  const avg = w.length ? w.reduce((a, b) => a + b, 0) / w.length : 3;
  return avg <= 2.4 ? 'warm' : (avg >= 3.6 ? 'cold' : 'mild');
}

function renderOutfits() {
  if (!libView.tab) libView.tab = libOf('idea').length ? 'idea' : 'kept';
  setSeg($('#lib-seg'), libView.tab);
  const tab = libView.tab;
  $('#ai-create').hidden = !(state.ai && tab === 'idea');
  $('#lib-tools').hidden = tab !== 'kept';
  const box = $('#lib-list');
  box.classList.toggle('grid2', tab === 'rejected');
  box.classList.toggle('cover-grid', tab === 'kept');
  if (tab === 'idea') {
    const ideas = libOf('idea');
    const held = libView.reviewHold && state.library.find((o) => o.id === libView.reviewHold.id);
    if (held && held.status === 'rejected') {
      box.innerHTML = rejectedPanel(held, 'lib', held.id, held.reason, true);
      return;
    }
    libView.reviewHold = null;
    if (!ideas.length) {
      box.innerHTML = `<div class="card empty">Nothing to review. ${state.ai ? 'Create outfits with AI above, or tap' : 'Tap'} Save on Today's new ideas.</div>`;
      return;
    }
    box.innerHTML = `<div class="review-count">1 of ${ideas.length} to review</div>${libCard(ideas[0], 'review')}`;
    return;
  }
  let list = libOf(tab);
  if (tab === 'kept') {
    if (libView.occ) list = list.filter((o) => !o.occasion || o.occasion === libView.occ);
    if (libView.season) list = list.filter((o) => seasonOf(o) === libView.season);
    const by = {
      rating: (a, b) => (b.avg_rating || 0) - (a.avg_rating || 0) || b.times_worn - a.times_worn || b.id - a.id,
      stale: (a, b) => (a.last_worn || '').localeCompare(b.last_worn || '') || b.id - a.id,
      new: (a, b) => b.id - a.id,
    }[libView.sort];
    list = [...list].sort(by);
  }
  if (!list.length) {
    box.innerHTML = `<div class="card empty">${{
      kept: libOf('kept').length ? 'No outfits match these filters.' : 'No outfits yet. Tap “＋ New outfit”, keep ideas from Today, or review AI ideas.',
      rejected: 'Nothing rejected.',
    }[tab]}</div>`;
    return;
  }
  box.innerHTML = tab === 'kept' ? list.map(coverCard).join('') : list.map((o) => libCard(o, tab)).join('');
}

async function runAI(body) {
  libView.tab = 'idea';
  if (state.view !== 'outfits') show('outfits');
  const box = $('#lib-list');
  box.innerHTML = '<div class="loading">Asking the AI…</div>';
  try {
    const r = await api('/api/ai/outfits', sendJSON('POST', body));
    await loadLibrary();
    toast(`${r.outfits.length} new outfit${r.outfits.length === 1 ? '' : 's'} to review`);
  } catch (e) {
    toast(e.message);
  }
  if (state.view === 'outfits') renderOutfits();
}

async function libPatch(o, body, msg) {
  try {
    const r = await api(`/api/library/${o.id}`, sendJSON('PATCH', body));
    Object.assign(o, r);
    updateLibCounts();
    if (msg) toast(msg);
    return true;
  } catch (e) { toast(e.message); return false; }
}

// ---------- outfit tools: flat lay, try-on, swap, photos ----------
function getOutfit(kind, ref) {
  if (kind === 'today') return state.today[ref];
  if (kind === 'lib') return (state.library || []).find((o) => o.id === ref);
  return state.history.find((o) => o.id === ref);
}
function cardEl(kind, ref) { return $(`.outfit-card[data-kind="${kind}"][data-ref="${ref}"]`); }
function rerenderCard(kind, ref) {
  if (kind === 'history') { renderHistory(); return; }
  if (kind === 'lib') { if (state.view === 'outfits') renderOutfits(); refreshDetail(ref); return; }
  const el = cardEl(kind, ref);
  const o = getOutfit(kind, ref);
  if (el && o) el.outerHTML = todayCard(o, ref);
}

// flat lay: the pieces laid out like a magazine photo (free, made in the browser)
const FLAT_SPOTS = {
  top: [30, 4, 40, 36], layer: [50, 10, 38, 34], dress: [28, 4, 44, 62], suit: [4, 6, 38, 40],
  outerwear: [58, 3, 38, 42], bottom: [30, 40, 40, 44], shoes: [60, 76, 32, 20], socks: [8, 78, 22, 18],
};
function flatLayHTML(items, withNames = true) {
  const tops = items.filter((i) => i.category === 'top');
  const acc = items.filter((i) => i.category === 'accessory');
  const outer = items.some((i) => i.category === 'outerwear');
  const pieces = items.filter((i) => i.category !== 'accessory').map((it) => {
    let spot = FLAT_SPOTS[it.category] || FLAT_SPOTS.top;
    if (it.category === 'top' && tops.length > 1 && it === tops[1]) spot = FLAT_SPOTS.layer;
    if (it.category === 'outerwear' && !items.some((i) => i.category === 'suit')) spot = [4, 3, 38, 42];
    if (it.category === 'suit' && outer) spot = [4, 6, 38, 40];
    return [it, spot];
  });
  acc.forEach((it, n) => pieces.push([it, [76, 46 + n * 15, 20, 14]]));
  const html = pieces.map(([it, [l, t, w, h]]) => {
    const pos = `left:${l}%;top:${t}%;width:${w}%;height:${h}%`;
    if (it.photo_url) return `<div class="fl" style="${pos}"><img src="${esc(it.photo_url)}" alt="${esc(it.name)}"></div>`;
    const c = cssColor(it.color);
    return `<div class="fl sw" style="${pos};${c ? `--sw:${c}` : ''}" title="${esc(it.name)}">${CAT_ICON[it.category] || '•'}</div>`;
  }).join('');
  return `<div class="flatlay">${html}</div>${withNames ? `<div class="flatlay-names">${items.map((i) => esc(displayName(i))).join(' · ')}</div>` : ''}`;
}

let viewerCtx = null;
function openViewer(title, body, foot = '') {
  $('#viewer-title').textContent = title;
  $('#viewer-body').innerHTML = body;
  $('#viewer-foot').innerHTML = foot;
  if (!$('#viewer').open) $('#viewer').showModal();
}

function openFlatLay(o) {
  viewerCtx = null;
  const missing = o.items.filter((i) => !i.photo_url).length;
  openViewer(o.name || 'Flat lay', flatLayHTML(o.items)
    + (missing ? `<div class="viewer-note">${missing} piece${missing > 1 ? 's have' : ' has'} no photo, so ${missing > 1 ? 'they show' : 'it shows'} as a color block.</div>` : ''));
}

function openPhoto(o, kind, ref, photoId) {
  const ph = (o.photos || []).find((x) => x.id === photoId);
  if (!ph) return;
  viewerCtx = { o, kind, ref, ph };
  const foot = [];
  if (ph.source === 'own' && state.ai) {
    foot.push(ph.review
      ? `<button type="button" class="btn primary" data-vact="check">See the check (${ph.review.score}/10)</button>`
      : '<button type="button" class="btn primary" data-vact="check">🔍 Check this look</button>');
  }
  if (ph.source === 'own' && state.cutout) {
    foot.push(ph.has_original
      ? '<button type="button" class="btn ghost" data-vact="restore">Restore original</button>'
      : '<button type="button" class="btn" data-vact="cutout">Remove background</button>');
  }
  foot.push('<button type="button" class="btn danger-ghost" data-vact="delete">Delete</button>');
  const note = ph.source === 'tryon'
    ? '<div class="viewer-note">AI picture: good for judging colors and proportions. The fit and small details can differ from real life.</div>' : '';
  openViewer(ph.source === 'tryon' ? 'Try-on' : 'Your photo', `<img src="${esc(ph.url)}" alt="">${note}`, `<span></span><div class="dlg-foot-left">${foot.join('')}</div>`);
}

// the saved outfit behind a card, if there is one (My outfits, To review, or one of yours on Today)
function savedOf(o, kind) {
  if (kind === 'lib') return o;
  return o.library_id ? (state.library || []).find((x) => x.id === o.library_id) || null : null;
}

// ---------- piece details ----------
function openPiece(o, kind, ref, itemId) {
  const it = state.items.find((i) => i.id === itemId) || o.items.find((i) => i.id === itemId);
  if (!it) return;
  viewerCtx = { piece: { o, kind, ref, itemId } };
  const photo = it.photo_url
    ? `<img src="${esc(it.photo_url)}" alt="">`
    : `<div class="thumb swatch" ${cssColor(it.color) ? `style="--sw:${cssColor(it.color)}"` : ''}><span>${CAT_ICON[it.category] || '•'}</span></div>`;
  const colors = [it.color, it.color2].filter(Boolean).join(' with ');
  const facts = [
    ['Type', it.kind ? kindLabel(it.kind) : SINGULAR[it.category]],
    ['Colors', colors],
    ['Material', it.material],
    ['Pattern', it.pattern && it.pattern !== 'solid' ? kindLabel(it.pattern) : (it.pattern ? 'Solid' : '')],
    ['Fit', it.fit ? kindLabel(it.fit) : ''],
    ['Warmth', WARMTH[it.warmth]],
    ['Formality', OCCASIONS[it.formality]],
    ['Tags', it.tags],
    ['Worn', it.times_worn ? `${it.times_worn}× · last ${agoText(it.last_worn)}` : (it.times_worn === 0 ? 'Not yet' : '')],
  ].filter(([, v]) => v);
  const state_ = [it.in_laundry ? 'In the laundry' : '', it.archived ? 'Archived' : ''].filter(Boolean).join(' · ');
  const body = `<div class="piece-detail">
      <div class="piece-photo">${photo}</div>
      ${it.brand ? `<div class="piece-brand">${esc(it.brand)}</div>` : ''}
      <h3>${esc(it.name)}</h3>
      ${state_ ? `<div class="import-status error small">${esc(state_)}</div>` : ''}
      <dl class="piece-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      ${it.notes ? `<div class="outfit-note">${esc(it.notes)}</div>` : ''}
    </div>`;
  const back = kind === 'lib' && detailId === o.id ? '<button type="button" class="btn ghost" data-vact="piece-back">‹ Back to outfit</button>' : '<span></span>';
  openViewer(SINGULAR[it.category] || 'Piece', body, `${back}<div class="dlg-foot-left">
      <button type="button" class="btn" data-vact="piece-edit">✎ Edit item</button>
      <button type="button" class="btn primary" data-vact="piece-swap">↔ Swap</button></div>`);
}

async function openSwap(o, kind, ref, itemId) {
  let r;
  try {
    const saved = savedOf(o, kind);
    r = saved
      ? await api(`/api/library/${saved.id}/swap?item_id=${itemId}`)
      : await api('/api/swap-options', sendJSON('POST', { item_ids: o.items.map((i) => i.id), item_id: itemId, occasion: state.occasion }));
  } catch (e) { toast(e.message); return; }
  viewerCtx = { swap: o, kind, ref, itemId, options: r.options };
  const cards = r.options.map((x) => `<button type="button" class="swap-card ${x.ok ? '' : 'bad'}" data-vact="swap-to" data-item="${x.item.id}">
      ${thumb(x.item)}<span class="swap-name">${esc(displayName(x.item))}</span>
      <span class="why">${x.ok ? (x.item.in_laundry ? 'In the laundry right now' : 'Fits your rules') : esc(x.problems.join(' '))}</span></button>`).join('');
  const now = `<div class="swap-now">${thumb(r.current)}<div><div class="muted small">Now</div><strong>${esc(displayName(r.current))}</strong></div></div>`;
  openViewer(`Swap the ${SINGULAR[r.current.category]?.toLowerCase() || 'piece'}`,
    `${now}<div class="swap-grid">${cards || '<div class="muted">Nothing else in this category yet.</div>'}</div>`,
    `<button type="button" class="btn ghost" data-vact="swap-back">‹ Back</button>${r.removable ? '<div class="dlg-foot-left"><button type="button" class="btn danger-ghost" data-vact="swap-remove">Remove this piece</button></div>' : ''}`);
}

async function applySwap(newId) {
  const { swap: o, kind, ref, itemId, options } = viewerCtx;
  const newItem = newId ? options.find((x) => x.item.id === newId)?.item : null;
  const ids = o.items.map((i) => i.id).filter((id) => id !== itemId);
  if (newId) ids.push(newId);
  const saved = savedOf(o, kind);
  try {
    if (saved) {
      const r = await api(`/api/library/${saved.id}`, sendJSON('PUT', { item_ids: ids, name: saved.name, notes: saved.notes, occasion: saved.occasion }));
      Object.assign(saved, r);
      if (kind !== 'lib') o.items = r.items;
      toast(r.warnings?.length ? `Changed. Note: ${r.warnings[0]}` : 'Changed');
    } else {
      // a new idea on Today: only this card changes; Save or Wear uses the new version
      o.items = o.items.filter((i) => i.id !== itemId).concat(newItem ? [newItem] : []);
      o.items.sort(byOrder);
      toast('Changed');
    }
    if (kind === 'lib' && detailId === o.id) openOutfit(o); else $('#viewer').close();
    if (kind === 'lib') renderOutfits(); else rerenderCard(kind, ref);
  } catch (e) { toast(e.message); }
}

async function viewerAction(act, btn) {
  if (act === 'swap-to') { applySwap(Number(btn.dataset.item)); return; }
  if (act === 'swap-remove') { applySwap(null); return; }
  if (act === 'swap-back') {
    const { swap: o, kind, ref, itemId } = viewerCtx;
    openPiece(o, kind, ref, itemId);
    return;
  }
  if (viewerCtx?.piece) {
    const { o, kind, ref, itemId } = viewerCtx.piece;
    if (act === 'piece-swap') { openSwap(o, kind, ref, itemId); return; }
    if (act === 'piece-back') { openOutfit(o); return; }
    if (act === 'piece-edit') {
      const it = state.items.find((i) => i.id === itemId);
      $('#viewer').close();
      if (it) openItem(it);
      return;
    }
  }
  const { o, kind, ref, ph } = viewerCtx || {};
  if (!ph) return;
  if (act === 'check') { if (ph.review) openReview(o, kind, ref, ph); else runCheck(o, kind, ref, ph); return; }
  if (act === 'recheck') { runCheck(o, kind, ref, ph); return; }
  if (act === 'review-photo') { openPhoto(o, kind, ref, ph.id); return; }
  if (act === 'apply-swap') {
    const s = ph.review.swaps[Number(btn.dataset.i)];
    const ids = o.items.map((i) => i.id).filter((id) => id !== s.out_id).concat(s.in_id);
    btn.disabled = true;
    try {
      const r = await api(`/api/library/${o.id}`, sendJSON('PUT', { item_ids: ids, name: o.name, notes: o.notes, occasion: o.occasion }));
      Object.assign(o, r);
      btn.textContent = 'Applied ✓';
      renderOutfits();
      toast(`Swapped in the ${s.in_name}.`);
    } catch (e) { toast(e.message); btn.disabled = false; }
    return;
  }
  if (act === 'delete') {
    if (!confirm('Delete this picture?')) return;
    try {
      await api(`/api/outfit-photos/${ph.id}`, { method: 'DELETE' });
      o.photos = o.photos.filter((x) => x.id !== ph.id);
      $('#viewer').close();
      rerenderCard(kind, ref);
      if (kind === 'lib') refreshDetail(ref);
      toast('Deleted');
    } catch (e) { toast(e.message); }
    return;
  }
  btn.disabled = true;
  btn.textContent = act === 'cutout' ? 'Removing background…' : 'Restoring…';
  try {
    const np = await api(`/api/outfit-photos/${ph.id}/${act === 'cutout' ? 'cutout' : 'restore'}`, { method: 'POST' });
    Object.assign(ph, np);
    rerenderCard(kind, ref);
    openPhoto(o, kind, ref, ph.id);
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  }
}

async function tryOn(o, kind, ref, btn) {
  if (!state.settings.tryon_body_url) {
    toast('Add a full-body photo of yourself in Settings → Try-on first.');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Creating… up to a minute';
  try {
    const ph = await api('/api/tryon', sendJSON('POST', { item_ids: o.items.map((i) => i.id), saved_id: o.id }));
    o.photos = [...(o.photos || []), ph];
    rerenderCard(kind, ref);
    openPhoto(o, kind, ref, ph.id);
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
    btn.textContent = '👤 Try on';
  }
}

// ---------- outfit check: a critical AI look at a photo of you wearing the outfit ----------
let checkTarget = null;
function startCheck(kind, id) {
  checkTarget = { kind, id };
  $('#check-photo-input').click();
}
async function checkNewPhoto(file) {
  const { kind, id } = checkTarget || {};
  const o = getOutfit(kind, id);
  if (!o) return;
  detailId = null;
  viewerCtx = null;
  openViewer('Outfit check', '<div class="loading">Uploading your photo…</div>');
  const fd = new FormData();
  fd.append('photo', await shrinkPhoto(file, 1600), 'photo.jpg');
  try {
    const ph = await api(kind === 'lib' ? `/api/library/${id}/photos` : `/api/outfits/${id}/photos`, { method: 'POST', body: fd });
    o.photos = [...(o.photos || []), ph];
    runCheck(o, kind, id, ph);
  } catch (e) {
    openViewer('Outfit check', `<div class="import-status error">${esc(e.message)}</div>`);
  }
}
async function runCheck(o, kind, ref, ph) {
  detailId = null;
  viewerCtx = null;
  openViewer('Outfit check', '<div class="loading">Looking closely at your outfit… (10–30 seconds)</div>');
  try {
    const np = await api(`/api/outfit-photos/${ph.id}/check`, { method: 'POST' });
    Object.assign(ph, np);
    rerenderCard(kind, ref);
    openReview(o, kind, ref, ph);
  } catch (e) {
    viewerCtx = { o, kind, ref, ph };
    openViewer('Outfit check', `<div class="import-status error">${esc(e.message)}</div>`,
      '<span></span><div class="dlg-foot-left"><button type="button" class="btn" data-vact="recheck">Try again</button></div>');
  }
}
const VERDICT = { works: 'Works', almost: 'Almost', doesnt_work: 'Doesn’t work' };
function openReview(o, kind, ref, ph) {
  const r = ph.review;
  viewerCtx = { o, kind, ref, ph };
  detailId = null;
  const swaps = (r.swaps || []).map((s, i) => `<div class="swap-sugg"><span><span>${esc(s.out_name)} → <strong>${esc(s.in_name)}</strong></span>
      <span class="muted small">${esc(s.reason)}</span></span>
      ${kind === 'lib' ? `<button type="button" class="btn" data-vact="apply-swap" data-i="${i}">Apply</button>` : ''}</div>`).join('');
  const body = `<div class="review">
      <div class="review-head">
        <button type="button" class="review-photo" data-vact="review-photo" aria-label="See the photo"><img src="${esc(ph.url)}" alt=""></button>
        <div><div class="verdict v-${r.verdict}">${VERDICT[r.verdict] || ''}</div>
          <div class="score">${r.score}<span>/10</span></div>
          <div class="muted small">${esc([OCCASIONS[r.occasion], r.checked_on ? `checked ${dayLabel(r.checked_on).toLowerCase()}` : ''].filter(Boolean).join(' · '))}</div></div>
      </div>
      <p class="review-summary">${esc(r.summary)}</p>
      ${r.mismatch ? `<div class="import-status error small">${esc(r.mismatch)}</div>` : ''}
      ${r.problems?.length ? `<h4>Fix first</h4><ol class="review-problems">${r.problems.map((p) => `<li><strong>${esc(p.issue)}</strong><span>${esc(p.fix)}</span></li>`).join('')}</ol>` : ''}
      ${r.works?.length ? `<h4>What works</h4><ul class="review-works">${r.works.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      ${swaps ? `<h4>Swaps from your closet</h4><div class="swap-suggs">${swaps}</div>` : ''}
      <div class="viewer-note">An AI opinion from one photo. Light, angle and distance matter; a full-length photo works best.</div>
    </div>`;
  openViewer('Outfit check', body, '<span></span><div class="dlg-foot-left"><button type="button" class="btn ghost" data-vact="recheck">Check again</button></div>');
}

function reasonFrom(el) {
  const chips = $$('.chip.on', el).map((b) => b.textContent);
  const own = el.querySelector('[data-reason]').value.trim();
  return [...chips, own].filter(Boolean).join('; ');
}

// your own outfit photos
let photoTarget = null;
function pickOutfitPhoto(kind, id) {
  photoTarget = { kind, id };
  $('#outfit-photo-input').click();
}
async function uploadOutfitPhoto(kind, id, file) {
  const fd = new FormData();
  fd.append('photo', await shrinkPhoto(file, 1600), 'photo.jpg');
  toast('Uploading photo…');
  try {
    const ph = await api(kind === 'lib' ? `/api/library/${id}/photos` : `/api/outfits/${id}/photos`, { method: 'POST', body: fd });
    toast(kind === 'new' ? 'Photo added. You’ll find it in History.' : 'Photo added');
    if (kind === 'lib') {
      const o = getOutfit('lib', id);
      if (o) o.photos = [...(o.photos || []), ph];
      if (state.view === 'outfits') renderOutfits();
      refreshDetail(id); // the open outfit shows the new photo (and cover) right away
    } else if (state.view === 'history') renderHistory();
  } catch (e) { toast(e.message); }
}
function bindPhotoDrops(root) {
  $$('.outfit-card[data-kind="lib"], .hist[data-kind="history"]', root).forEach((el) => {
    if (el.dataset.dropBound) return;
    el.dataset.dropBound = '1';
    const kind = el.dataset.kind;
    dropTarget(el, (files) => uploadOutfitPhoto(kind, Number(el.dataset.ref), files[0]));
  });
}
function offerPhoto(after, outfitId) {
  const wrap = document.createElement('div');
  wrap.className = 'after-wear';
  wrap.innerHTML = `<button type="button" class="tool-btn" data-act="photo-new" data-outfit-id="${outfitId}">📷 Add a photo of it</button>`;
  after.insertAdjacentElement('afterend', wrap);
}

async function wearLib(o, btn, worn_on = dayDate(0), occasion = null) {
  btn.disabled = true;
  try {
    const r = await api(`/api/library/${o.id}/wear`, sendJSON('POST', { worn_on, occasion }));
    const planned = worn_on > dayDate(0);
    btn.textContent = planned ? 'Planned ✓' : 'Logged ✓';
    if (!planned) offerPhoto(btn.closest('.outfit-actions') || btn, r.id);
    toast(planned ? `Planned for ${dayLabel(worn_on)}. It’s in History.` : 'Logged. Rate it later in History.');
    await loadItems();
    await loadLibrary();
    if (state.view === 'outfits') renderOutfits();
  } catch (e) {
    btn.disabled = false;
    toast(e.message);
  }
}

async function onOutfitTool(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, kind } = el.dataset;
  if (act === 'photo-new') { pickOutfitPhoto('new', Number(el.dataset.outfitId)); return; }
  const ref = Number(el.dataset.ref);
  const o = getOutfit(kind, ref);
  if (!o) return;
  if (act === 'flat') openFlatLay(o);
  else if (act === 'tryon') tryOn(o, kind, ref, el);
  else if (act === 'photo') pickOutfitPhoto(kind, o.id);
  else if (act === 'check') startCheck(kind, o.id);
  else if (act === 'view') openPhoto(o, kind, ref, Number(el.dataset.photo));
  else if (act === 'piece') openPiece(o, kind, ref, Number(el.dataset.item));
  else if (act === 'edit') openLog(o, 'lib');
  else if (act === 'wear') wearLib(o, el);
  else if (act === 'open') openOutfit(o);
  else if (act === 'plan') {
    const d = $('#plan-date').value;
    if (!d || d <= dayDate(0)) { toast('Pick a day after today.'); return; }
    wearLib(o, el, d);
  }
  else if (act === 'delete') {
    if (!confirm(`Delete “${o.name || 'this outfit'}”? History keeps the days you wore it.`)) return;
    try {
      await api(`/api/library/${o.id}`, { method: 'DELETE' });
      state.library = state.library.filter((x) => x !== o);
      if (detailId === o.id && $('#viewer').open) $('#viewer').close();
      updateLibCounts();
      renderOutfits();
      toast('Deleted');
    } catch (err) { toast(err.message); }
  } else if (act === 'keep') {
    if (kind === 'today') keepToday(o, ref);
    else if (await libPatch(o, { status: 'kept' }, 'Saved to My outfits.')) renderOutfits();
  } else if (act === 'later') {
    if (await libPatch(o, { later: true })) { await loadLibrary(); renderOutfits(); }
  } else if (act === 'reject') {
    if (kind === 'today') rejectToday(o, ref);
    else if (await libPatch(o, { status: 'rejected' })) { libView.reviewHold = { id: o.id }; renderOutfits(); }
  } else if (act === 'restore') {
    if (await libPatch(o, { status: 'idea' }, 'Back in “To review”.')) renderOutfits();
  } else if (act === 'reason-chip' || act === 'reason') {
    if (act === 'reason-chip') el.classList.toggle('on');
    const reason = reasonFrom(el.closest('.discarded-card'));
    const id = kind === 'today' ? o.rejected?.id : o.id;
    if (!id) return;
    try {
      await api(`/api/library/${id}`, sendJSON('PATCH', { reason }));
      if (kind === 'today') o.rejected.reason = reason; else o.reason = reason;
      if (act === 'reason') toast(state.ai ? 'Noted. The AI will take it into account.' : 'Noted');
    } catch (err) { toast(err.message); }
  } else if (act === 'undo') {
    if (kind === 'today') undoRejectToday(o, ref);
    else if (await libPatch(o, { status: 'idea' })) { libView.reviewHold = null; renderOutfits(); }
  } else if (act === 'next') {
    libView.reviewHold = null;
    renderOutfits();
  }
}

// Today: keep or reject a new idea
async function keepToday(o, ref) {
  try {
    const r = await api('/api/library', sendJSON('POST', {
      item_ids: o.items.map((i) => i.id), status: 'kept', source: 'today', occasion: state.occasion,
    }));
    o.kept = true;
    o.library_id = r.id;
    rerenderCard('today', ref);
    toast('Saved to My outfits. Wear it whenever you like.');
    loadLibrary();
  } catch (e) { toast(e.message); }
}
async function rejectToday(o, ref) {
  try {
    const r = await api('/api/library', sendJSON('POST', {
      item_ids: o.items.map((i) => i.id), status: 'rejected', source: 'today', occasion: state.occasion,
    }));
    o.rejected = { id: r.id, reason: '' };
    rerenderCard('today', ref);
    loadLibrary();
  } catch (e) { toast(e.message); }
}
async function undoRejectToday(o, ref) {
  try {
    await api(`/api/library/${o.rejected.id}`, { method: 'DELETE' });
    o.rejected = null;
    rerenderCard('today', ref);
    loadLibrary();
  } catch (e) { toast(e.message); }
}

// ---------- filling the item form (AI / shop link) ----------
const FORM_KEYS = ['name', 'category', 'color', 'color2', 'pattern', 'material', 'fit', 'brand', 'tags'];

function fillItemForm(d, overwrite) {
  const f = $('#item-form');
  const kindBefore = f.kind.value;
  FORM_KEYS.forEach((k) => {
    if (d[k] === undefined || d[k] === null) return;
    if (!overwrite && !d[k]) return; // don't blank out what the user typed
    f[k].value = d[k];
  });
  updateKindOptions(d.kind || (overwrite ? '' : kindBefore));
  if (d.warmth) { f.warmth.value = d.warmth; $('#warmth-label').textContent = WARMTH[d.warmth]; }
  if (d.formality) setSeg($('#formality-seg'), d.formality);
}

async function importFromUrl() {
  const url = $('#import-url').value.trim();
  if (!url) { setImportStatus('Paste a product link first.', true); return; }
  const btn = $('#import-btn');
  btn.disabled = true;
  btn.textContent = 'Reading…';
  setImportStatus('Reading the page… this can take a few seconds.');
  try {
    const r = await api('/api/import-url', sendJSON('POST', { url }));
    fillItemForm(r.fields, false);
    if (r.photo) {
      const blob = await (await fetch(r.photo)).blob();
      pendingPhoto = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
      removePhoto = false;
      setPreview(URL.createObjectURL(pendingPhoto));
      $('#cutout-toggle').checked = false; // shop photos usually have a clean background already
      updateAIButtons();
    }
    let msg = 'Filled in from the page. Check the details, then save.';
    if (r.ai_error) msg = `Filled in what the page shows. The AI part failed: ${r.ai_error}`;
    else if (!r.photo) msg = 'Filled in, but no photo was found on the page. Add one if you like.';
    setImportStatus(msg, !!r.ai_error);
  } catch (e) {
    setImportStatus(`Couldn't use that link: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fetch';
  }
}

// ---------- photo background ----------
async function photoAction(kind) {
  const btn = kind === 'cutout' ? $('#cutout-btn') : $('#restore-btn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = kind === 'cutout' ? 'Removing background…' : 'Restoring…';
  try {
    const it = await api(`/api/items/${editing.id}/${kind === 'cutout' ? 'cutout' : 'restore-photo'}`, { method: 'POST' });
    Object.assign(editing, it);
    const inList = state.items.find((i) => i.id === it.id);
    if (inList && inList !== editing) Object.assign(inList, it);
    setPreview(it.photo_url);
    if (state.view === 'closet') renderCloset();
    toast(kind === 'cutout' ? 'Background removed. “Restore original photo” undoes it.' : 'Original photo restored');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    updateAIButtons();
  }
}

async function cleanupAllPhotos() {
  const todo = state.items.filter((i) => i.photo_url && !i.has_original);
  const status = $('#cleanup-status');
  if (!todo.length) { status.textContent = 'All photos already have their background removed.'; return; }
  if (!confirm(`Remove the background from ${todo.length} photo${todo.length > 1 ? 's' : ''}? Originals are kept, so you can undo it per item.`)) return;
  const btn = $('#cleanup-btn');
  btn.disabled = true;
  let done = 0;
  const failed = [];
  for (const it of todo) {
    status.textContent = `Working… ${done + failed.length + 1} of ${todo.length}`;
    try { await api(`/api/items/${it.id}/cutout`, { method: 'POST' }); done += 1; } catch (e) { failed.push(it.name); }
  }
  status.textContent = `Done: ${done} cleaned up.` + (failed.length ? ` Couldn't do: ${failed.join(', ')}.` : '');
  btn.disabled = false;
  await loadItems();
  if (state.view === 'closet') renderCloset();
}

// ---------- brand picker ----------
const combo = { opts: [], idx: -1 };

function brandOptions(q) {
  const byLower = new Map();
  state.items.forEach((i) => { if (i.brand && !byLower.has(i.brand.toLowerCase())) byLower.set(i.brand.toLowerCase(), i.brand); });
  const all = [...byLower.values()].sort((a, b) => a.localeCompare(b));
  const ql = q.trim().toLowerCase();
  const starts = all.filter((b) => b.toLowerCase().startsWith(ql));
  const contains = ql ? all.filter((b) => !b.toLowerCase().startsWith(ql) && b.toLowerCase().includes(ql)) : [];
  const opts = [...starts, ...contains].slice(0, 8).map((b) => ({ value: b, label: b }));
  if (ql && !byLower.has(ql)) opts.push({ value: q.trim(), label: `Add “${q.trim()}”`, add: true });
  return opts;
}

function showBrands() {
  const input = $('#item-form').brand;
  const list = $('#brand-list');
  combo.opts = brandOptions(input.value);
  combo.idx = -1;
  if (!combo.opts.length) { hideBrands(); return; }
  const ql = input.value.trim().toLowerCase();
  list.innerHTML = combo.opts.map((o, i) => {
    let label = esc(o.label);
    const at = o.add ? -1 : o.label.toLowerCase().indexOf(ql);
    if (ql && at >= 0) label = `${esc(o.label.slice(0, at))}<mark>${esc(o.label.slice(at, at + ql.length))}</mark>${esc(o.label.slice(at + ql.length))}`;
    return `<div class="combo-opt ${o.add ? 'add' : ''}" role="option" data-i="${i}">${label}</div>`;
  }).join('');
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  list.scrollIntoView({ block: 'nearest' }); // near the bottom of the form it would hide behind Save
}
function hideBrands() {
  $('#brand-list').hidden = true;
  $('#item-form').brand.setAttribute('aria-expanded', 'false');
}
function pickBrand(i) {
  $('#item-form').brand.value = combo.opts[i].value;
  hideBrands();
}
function highlightBrand(step) {
  if (!combo.opts.length) return;
  combo.idx = (combo.idx + step + combo.opts.length) % combo.opts.length;
  $$('.combo-opt', $('#brand-list')).forEach((el, i) => {
    el.classList.toggle('on', i === combo.idx);
    if (i === combo.idx) el.scrollIntoView({ block: 'nearest' });
  });
}

// ---------- AI item fill ----------
function setImportStatus(msg, isError = false) {
  const el = $('#import-status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function updateAIButtons() {
  const hasPhoto = !!pendingPhoto || (!!editing?.photo_url && !removePhoto);
  const savedPhoto = !!editing?.photo_url && !pendingPhoto && !removePhoto;
  $('#cutout-check').hidden = !(state.cutout && pendingPhoto);
  $('#cutout-btn').hidden = !(state.cutout && savedPhoto && !editing.has_original);
  $('#restore-btn').hidden = !(savedPhoto && editing.has_original);
  $('#photo-actions').hidden = $('#cutout-btn').hidden && $('#restore-btn').hidden;
  $('#ai-fill-btn').hidden = !state.ai || !hasPhoto;
  $('#build-btn').hidden = !state.ai || !editing || editing.archived;
}

async function aiFill() {
  const btn = $('#ai-fill-btn');
  btn.disabled = true;
  btn.textContent = 'Looking at the photo…';
  try {
    const blob = pendingPhoto || await (await fetch(editing.photo_url)).blob();
    const fd = new FormData();
    fd.append('photo', blob, 'photo.jpg');
    const d = await api('/api/ai/describe', { method: 'POST', body: fd });
    fillItemForm(d, true);
    toast('Filled in. Check the details, then save.');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Fill in with AI';
  }
}

// ---------- photos from files, drops and paste ----------
const BULK_MAX = 50;
const isImage = (f) => f && (f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i.test(f.name || ''));
const imageFiles = (list) => [...(list || [])].filter(isImage);
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

// Shrink big phone photos before upload (the server stores 1200 px anyway).
async function shrinkPhoto(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) { bmp.close(); return file; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent PNGs become JPEG
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
    return blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file; // the browser can't read it (e.g. HEIC); let the server try
  }
}

function usePhoto(file) {
  pendingPhoto = file;
  removePhoto = false;
  $('#cutout-toggle').checked = true;
  setPreview(URL.createObjectURL(file));
  updateAIButtons();
}

// Highlight an element while files are dragged over it; call onDrop with the image files.
function dropTarget(el, onDrop) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth += 1; el.classList.add('drop'); });
  el.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove('drop'); });
  el.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    el.classList.remove('drop');
    const files = imageFiles(e.dataTransfer.files);
    if (files.length) onDrop(files); else toast('That isn’t a photo.');
  });
}

// ---------- ADD MANY ----------
const bulk = { rows: [], seq: 0, filling: false, saving: false, run: 0, saveTotal: 0, saveDone: 0 };

function defaultName(file, n) {
  const base = (file.name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  // camera names like IMG_1234 or PXL_2026… say nothing about the item
  if (!base || /^(img|dsc|dscn|pxl|photo|image|screenshot|whatsapp|signal|mvimg)\b/i.test(base) || /^\d/.test(base)) return `Item ${n}`;
  return (base[0].toUpperCase() + base.slice(1)).slice(0, 120);
}

function openBulk(files = []) {
  if (!$('#bulk-dialog').open) {
    resetBulk();
    $('#bulk-cutout').checked = true;
    $('#bulk-dialog').showModal();
  }
  if (files.length) addBulkFiles(files);
}

function resetBulk() {
  bulk.rows.forEach((r) => { if (r.url.startsWith('blob:')) URL.revokeObjectURL(r.url); });
  bulk.rows = [];
  bulk.seq = 0;
  bulk.filling = false;
  bulk.saving = false;
  bulk.run += 1; // stops loops still running from before
  $('#bulk-input').value = '';
  renderBulk();
}

function bulkUnsaved() { return bulk.rows.filter((r) => r.status !== 'saved'); }

function closeBulk() {
  const left = bulkUnsaved().length;
  if (left && !confirm(`Close without saving ${left} photo${left > 1 ? 's' : ''}?`)) return;
  $('#bulk-dialog').close();
  resetBulk();
}

async function addBulkFiles(files) {
  if (bulk.saving) { toast('Wait until saving is done.'); return; }
  const images = imageFiles(files);
  const take = images.slice(0, Math.max(0, BULK_MAX - bulk.rows.length));
  if (images.length > take.length) toast(`Up to ${BULK_MAX} photos at a time. Save these first, then add more.`);
  if (!take.length) return;
  const run = bulk.run;
  const cat = CAT_LABEL[state.filter] ? state.filter : 'top';
  const added = take.map((file) => {
    bulk.seq += 1;
    return {
      id: bulk.seq, file, url: URL.createObjectURL(file), name: defaultName(file, bulk.seq), category: cat,
      fields: {}, status: state.ai ? 'queued' : 'ready', note: state.ai ? 'Waiting for AI…' : '',
    };
  });
  bulk.rows.push(...added);
  renderBulk();
  // shrink in the background so the list shows up right away
  for (const r of added) {
    const small = await shrinkPhoto(r.file);
    if (run !== bulk.run) return;
    if (small !== r.file) {
      URL.revokeObjectURL(r.url);
      r.file = small;
      r.url = URL.createObjectURL(small);
      const img = $(`.bulk-row[data-row="${r.id}"] img`);
      if (img) img.src = r.url;
    }
    r.shrunk = true;
    if (state.ai) fillBulk();
  }
}

async function fillBulk() {
  if (bulk.filling) return;
  bulk.filling = true;
  const run = bulk.run;
  renderBulkProgress();
  // two at a time: faster than one, gentle on rate limits
  const worker = async () => {
    for (;;) {
      if (run !== bulk.run) return;
      const r = bulk.rows.find((x) => x.status === 'queued' && x.shrunk);
      if (!r) return;
      r.status = 'filling';
      r.note = 'AI is looking…';
      renderBulkRow(r);
      try {
        const fd = new FormData();
        fd.append('photo', r.file, 'photo.jpg');
        const d = await api('/api/ai/describe', { method: 'POST', body: fd });
        if (run !== bulk.run || !bulk.rows.includes(r)) continue;
        const { name, category, ...rest } = d;
        if (name && !r.touchedName) r.name = name;
        if (category && !r.touchedCategory) r.category = category;
        r.fields = rest;
        r.status = 'ready';
        r.note = [d.color, d.material, d.pattern && d.pattern !== 'solid' ? d.pattern : ''].filter(Boolean).join(' · ');
      } catch (e) {
        if (run !== bulk.run || !bulk.rows.includes(r)) continue;
        r.status = 'warn';
        r.note = `AI couldn't fill this in: ${e.message}`;
      }
      renderBulkRow(r);
      renderBulkProgress();
    }
  };
  await Promise.all([worker(), worker()]);
  if (run !== bulk.run) return;
  bulk.filling = false;
  // a photo may have finished shrinking just as the workers stopped
  if (bulk.rows.some((x) => x.status === 'queued' && x.shrunk)) fillBulk();
  else renderBulkProgress();
}

function bulkRowHTML(r) {
  const locked = r.status === 'saved' || r.status === 'saving' || bulk.saving;
  const cats = CATS.map(([k]) => `<option value="${k}" ${k === r.category ? 'selected' : ''}>${SINGULAR[k]}</option>`).join('');
  const busy = ['queued', 'filling', 'saving'].includes(r.status);
  return `<div class="bulk-row ${r.status} ${busy ? 'busy' : ''}" data-row="${r.id}">
      <img src="${esc(r.url)}" alt="">
      <div class="bulk-fields">
        <input data-k="name" value="${esc(r.name)}" maxlength="120" aria-label="Name" ${locked ? 'disabled' : ''}>
        <select data-k="category" aria-label="Category" ${locked ? 'disabled' : ''}>${cats}</select>
        <div class="bulk-note">${esc(r.note)}</div>
      </div>
      ${r.status === 'saved' ? '<span class="bulk-done" aria-label="Saved">✓</span>'
        : `<button type="button" class="icon-btn" data-remove="${r.id}" aria-label="Remove this photo" ${locked ? 'disabled' : ''}>✕</button>`}
    </div>`;
}

function renderBulkRow(r) {
  const el = $(`.bulk-row[data-row="${r.id}"]`);
  if (!el) return;
  // keep the cursor where it was if the user is typing in this row
  const active = el.contains(document.activeElement) ? document.activeElement : null;
  const key = active?.dataset.k;
  const caret = key === 'name' ? active.selectionStart : null;
  el.outerHTML = bulkRowHTML(r);
  if (key) {
    const again = $(`.bulk-row[data-row="${r.id}"] [data-k="${key}"]`);
    if (again && !again.disabled) {
      again.focus();
      if (caret !== null) again.setSelectionRange(caret, caret);
    }
  }
}

function renderBulk() {
  $('#bulk-list').innerHTML = bulk.rows.map(bulkRowHTML).join('');
  $('#bulk-drop').classList.toggle('compact', bulk.rows.length > 0);
  $('#bulk-drop strong').textContent = bulk.rows.length ? 'Add more photos' : 'Drop photos here or tap to choose';
  $('#bulk-drop-hint').textContent = state.ai
    ? `One photo per item, up to ${BULK_MAX} at a time. AI fills in the details.`
    : `One photo per item, up to ${BULK_MAX} at a time.`;
  $('#bulk-cutout-check').hidden = !state.cutout;
  $('#bulk-cutout').disabled = bulk.saving;
  renderBulkProgress();
}

function renderBulkProgress() {
  const rows = bulk.rows;
  const btn = $('#bulk-save-btn');
  const todo = bulkUnsaved();
  const filling = rows.some((r) => r.status === 'queued' || r.status === 'filling');
  $('#bulk-progress').hidden = !rows.length;
  btn.textContent = todo.length ? `Save ${todo.length} item${todo.length > 1 ? 's' : ''}` : 'Save all';
  btn.disabled = bulk.saving || filling || !todo.length;
  if (!rows.length) return;
  let done;
  let total;
  let msg;
  if (bulk.saving) {
    total = bulk.saveTotal;
    done = bulk.saveDone;
    msg = `Saving ${Math.min(done + 1, total)} of ${total}…`;
    if (state.cutout && $('#bulk-cutout').checked) msg += ' Removing backgrounds takes a moment.';
  } else if (filling) {
    total = rows.length;
    done = rows.filter((r) => r.status !== 'queued' && r.status !== 'filling').length;
    msg = `AI is filling in ${done} of ${total}… You can fix names and categories meanwhile.`;
  } else {
    total = rows.length;
    done = rows.length - todo.length;
    const bad = rows.filter((r) => r.status === 'warn' || r.status === 'error').length;
    msg = todo.length
      ? `${todo.length} ready to save. Check names and categories; other details can be edited later.`
        + (bad ? ` ${bad} marked in red ${bad === 1 ? 'needs' : 'need'} a look.` : '')
      : `All ${rows.length} saved.`;
  }
  $('#bulk-status').textContent = msg;
  $('#bulk-bar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  $('#bulk-bar').parentElement.hidden = !(bulk.saving || filling);
}

async function saveBulk(e) {
  e.preventDefault();
  const todo = bulkUnsaved();
  if (!todo.length || bulk.saving) return;
  const run = bulk.run;
  bulk.saving = true;
  bulk.saveTotal = todo.length;
  bulk.saveDone = 0;
  renderBulk();
  const cutout = state.cutout && $('#bulk-cutout').checked;
  let saved = 0;
  let keptBackground = 0;
  for (const r of todo) {
    if (run !== bulk.run) return;
    r.status = 'saving';
    r.note = 'Saving…';
    renderBulkRow(r);
    renderBulkProgress();
    const fd = new FormData();
    fd.append('name', r.name.trim() || `Item ${r.id}`);
    fd.append('category', r.category);
    const f = r.fields;
    ['kind', 'color', 'color2', 'pattern', 'material', 'fit', 'brand'].forEach((k) => { if (f[k]) fd.append(k, f[k]); });
    if (f.warmth) fd.append('warmth', f.warmth);
    if (f.formality) fd.append('formality', f.formality);
    if (f.tags) fd.append('tags', Array.isArray(f.tags) ? f.tags.join(', ') : f.tags);
    fd.append('photo', r.file, 'photo.jpg');
    if (cutout) fd.append('cutout_photo', 'true');
    try {
      const it = await api('/api/items', { method: 'POST', body: fd });
      if (run !== bulk.run) return;
      r.status = 'saved';
      r.note = it.cutout_error ? `Saved. Background kept: ${it.cutout_error}` : 'Saved';
      if (it.cutout_error) keptBackground += 1;
      if (it.photo_url) { URL.revokeObjectURL(r.url); r.url = it.photo_url; }
      saved += 1;
    } catch (err) {
      if (run !== bulk.run) return;
      r.status = 'error';
      r.note = `Not saved: ${err.message}`;
    }
    bulk.saveDone += 1;
    renderBulkRow(r);
    renderBulkProgress();
  }
  bulk.saving = false;
  await loadItems();
  render();
  renderBulk();
  const failed = bulkUnsaved().length;
  if (!failed) {
    $('#bulk-dialog').close();
    resetBulk();
    toast(`Added ${saved} item${saved === 1 ? '' : 's'} to your closet`
      + (keptBackground ? `. ${keptBackground} kept their background` : ''));
  } else {
    toast(`${saved} saved, ${failed} not saved. Fix or remove them, then save again.`);
  }
}

function bindBulk() {
  $('#bulk-btn').onclick = () => openBulk();
  $('#bulk-input').addEventListener('change', (e) => { addBulkFiles(e.target.files); e.target.value = ''; });
  dropTarget($('#bulk-drop'), addBulkFiles);
  $('#bulk-form').addEventListener('submit', saveBulk);
  const dlg = $('#bulk-dialog');
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!bulk.saving) closeBulk(); });
  // drops anywhere in the dialog add photos too
  dlg.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  dlg.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); addBulkFiles(e.dataTransfer.files); });
  const list = $('#bulk-list');
  list.addEventListener('input', (e) => {
    const k = e.target.dataset.k;
    const r = bulk.rows.find((x) => x.id === Number(e.target.closest('[data-row]')?.dataset.row));
    if (!r || !k) return;
    r[k] = e.target.value;
    if (k === 'name') r.touchedName = true; else r.touchedCategory = true;
  });
  list.addEventListener('change', (e) => {
    if (e.target.dataset.k !== 'category') return;
    const r = bulk.rows.find((x) => x.id === Number(e.target.closest('[data-row]')?.dataset.row));
    if (r) { r.category = e.target.value; r.touchedCategory = true; }
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b || bulk.saving) return;
    const i = bulk.rows.findIndex((x) => x.id === Number(b.dataset.remove));
    if (i < 0) return;
    const [r] = bulk.rows.splice(i, 1);
    URL.revokeObjectURL(r.url);
    b.closest('.bulk-row').remove();
    renderBulk();
  });
}

// Dropping files on the page: one photo opens "Add item", several open "Add many".
function bindPageDrop() {
  const overlay = $('#drop-overlay');
  let depth = 0;
  const pageDropOK = () => state.view === 'closet' && !$$('dialog[open]').length;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth += 1;
    if (pageDropOK()) overlay.hidden = false;
  });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
  // never let the browser open a dropped file in place of the app
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = pageDropOK() ? 'copy' : 'none'; } });
  window.addEventListener('drop', (e) => {
    depth = 0;
    overlay.hidden = true;
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!pageDropOK()) return;
    const files = imageFiles(e.dataTransfer.files);
    if (!files.length) { toast('That isn’t a photo.'); return; }
    if (files.length === 1) { openItem(); usePhoto(files[0]); } else openBulk(files);
  });
  // paste a copied image into the open item form or the Add many list
  document.addEventListener('paste', (e) => {
    const files = imageFiles(e.clipboardData?.files);
    if (!files.length) return; // plain text paste works as usual
    if ($('#bulk-dialog').open) { e.preventDefault(); addBulkFiles(files); } else if ($('#item-dialog').open) { e.preventDefault(); usePhoto(files[0]); }
  });
}

// ---------- outfit rules ----------
const RULE_OCC = { 0: '', 1: 'Casual', 2: 'Work', 3: 'Formal' };

function ruleText(r) {
  const kinds = r.kinds.map((k) => k).join(' or ');
  let text;
  if (r.type === 'only') text = `${CAT_LABEL[r.category].toLowerCase()} only ${kinds}`;
  else if (r.type === 'never') text = `no ${kinds}`;
  else text = `${kinds} always over another top`;
  const t = (c) => `${Math.round(toDisplay(c))}°`;
  if (r.below !== null && r.below !== undefined) text += `, when colder than ${t(r.below)}`;
  if (r.above !== null && r.above !== undefined) text += `, when warmer than ${t(r.above)}`;
  const occ = RULE_OCC[r.occasion];
  return occ ? `${occ}: ${text}` : text[0].toUpperCase() + text.slice(1);
}

function renderRules() {
  const rules = state.settings.rules || [];
  $('#rules-list').innerHTML = rules.length
    ? rules.map((r, i) => `<div class="rule-row"><span>${esc(ruleText(r))}</span>
        <button type="button" class="icon-btn" data-del-rule="${i}" aria-label="Remove rule" title="Remove">✕</button></div>`).join('')
    : '<div class="muted small">No rules yet.</div>';
  // pieces without a type can't pass an "only" rule
  const cats = new Set(rules.filter((r) => r.type === 'only').map((r) => r.category));
  const untyped = state.items.filter((i) => !i.archived && cats.has(i.category) && !i.kind);
  $('#rules-untyped').textContent = untyped.length
    ? `${untyped.length} item${untyped.length > 1 ? 's have' : ' has'} no type yet, so those rules leave ${untyped.length > 1 ? 'them' : 'it'} out: `
      + untyped.slice(0, 6).map((i) => i.name).join(', ') + (untyped.length > 6 ? '…' : '') + '. Set the type in the item.'
    : '';
}

async function saveRules(rules, msg) {
  try {
    state.settings = await api('/api/settings', sendJSON('PUT', { rules }));
    renderRules();
    toast(msg);
    if (state.view === 'today') renderToday();
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

function setupRuleBuilder() {
  $('#rule-category').innerHTML = CATS.filter(([k]) => (state.kinds[k] || []).length)
    .map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  $('#rule-category').value = 'top';
  $$('.rule-unit').forEach((el) => { el.textContent = `°${state.settings.unit}`; });
  $('#rule-temp').value = Math.round(toDisplay(10));
  $('#rule-temp-mode').value = '';
  $('#rule-type').value = 'only';
  $('#rule-occasion').value = '2';
  $('#rule-status').textContent = '';
  updateRuleBuilder();
}

function ruleDraft() {
  const type = $('#rule-type').value;
  const mode = $('#rule-temp-mode').value;
  const temp = Number($('#rule-temp').value);
  const c = Math.round(fromDisplay(temp) * 10) / 10;
  return {
    type,
    occasion: Number($('#rule-occasion').value),
    category: type === 'under' ? 'top' : $('#rule-category').value,
    kinds: $$('#rule-kinds .chip.on').map((b) => b.dataset.kind),
    below: mode === 'below' ? c : null,
    above: mode === 'above' ? c : null,
  };
}

function updateRuleBuilder(keepKinds = false) {
  const type = $('#rule-type').value;
  $('#rule-cat-field').hidden = type === 'under';
  const cat = type === 'under' ? 'top' : $('#rule-category').value;
  const kinds = type === 'under' ? state.layerKinds : (state.kinds[cat] || []);
  const on = keepKinds ? new Set($$('#rule-kinds .chip.on').map((b) => b.dataset.kind)) : new Set();
  $('#rule-kinds').innerHTML = kinds.map((k) => `<button type="button" class="chip ${on.has(k) ? 'on' : ''}" data-kind="${esc(k)}">${esc(kindLabel(k))}</button>`).join('');
  $('#rule-kinds-hint').textContent = { only: '(tap all that are allowed)', never: '(tap what to avoid)', under: '(tap what needs a layer under it)' }[type];
  $('#rule-temp-field').hidden = !$('#rule-temp-mode').value;
  updateRulePreview();
}

function updateRulePreview() {
  const d = ruleDraft();
  $('#rule-preview').textContent = d.kinds.length ? `Rule: ${ruleText(d)}` : '';
}

async function addRule() {
  const d = ruleDraft();
  const status = $('#rule-status');
  if (!d.kinds.length) { status.textContent = 'Tap at least one type.'; status.classList.add('error'); return; }
  if ((d.below !== null || d.above !== null) && Number.isNaN(d.below ?? d.above)) { status.textContent = 'Enter a temperature.'; status.classList.add('error'); return; }
  status.textContent = '';
  if (await saveRules([...(state.settings.rules || []), d], 'Rule added')) {
    $('#rule-add').open = false;
    setupRuleBuilder();
  }
}

function renderTryonPhotos() {
  ['body', 'face'].forEach((which) => {
    const url = state.settings[`tryon_${which}_url`];
    const el = $(`#tryon-${which}-preview`);
    el.classList.toggle('has', !!url);
    el.innerHTML = url ? `<img src="${esc(url)}" alt="">` : `<span>${which === 'body' ? 'Full-body photo<br><small>tap or drop</small>' : 'Face close-up (optional)'}</span>`;
    $(`[data-remove-tryon="${which}"]`).hidden = !url;
  });
}
async function uploadTryon(which, file) {
  const fd = new FormData();
  fd.append('photo', await shrinkPhoto(file, 1600), 'photo.jpg');
  try {
    state.settings = await api(`/api/tryon/photo/${which}`, { method: 'POST', body: fd });
    renderTryonPhotos();
    toast('Photo saved');
  } catch (e) { toast(e.message); }
}

// ---------- SETTINGS ----------
let pendingLoc = null;

function openSettings() {
  const s = state.settings;
  const f = $('#settings-form');
  pendingLoc = null;
  $('#current-location').textContent = s.location_name || 'Not set';
  $('#loc-query').value = '';
  $('#loc-results').innerHTML = '';
  setSeg($('#unit-seg'), s.unit);
  $('#thresh-unit').textContent = `°${s.unit}`;
  f.outerwear_below.value = Math.round(toDisplay(s.outerwear_below));
  f.ai_prompt.value = s.ai_prompt || '';
  $('#photos-section').hidden = !state.cutout;
  f.openai_key.value = '';
  f.ai_model.value = s.ai_model || '';
  $('#model-list').innerHTML = (s.ai_models || []).map((m) => `<option value="${esc(m)}">`).join('');
  $('#default-model').textContent = (s.ai_models || ['gpt-6.1-terra'])[0];
  removeKey = false;
  showKeyStatus();
  $('#rule-add').open = false;
  setupRuleBuilder();
  renderRules();
  $('#menswear-toggle').checked = s.menswear !== false;
  $('#menswear-rules').innerHTML = (s.menswear_rules || []).map((r) => `<li>${esc(r)}</li>`).join('');
  f.tryon_quality.value = s.tryon_quality || 'medium';
  renderTryonPhotos();
  $('#test-result').textContent = '';
  $('#settings-dialog').showModal();
}
async function searchLocation() {
  const q = $('#loc-query').value.trim();
  if (q.length < 2) return;
  const box = $('#loc-results');
  box.innerHTML = '<div class="muted small">Searching…</div>';
  try {
    const results = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (!results.length) { box.innerHTML = '<div class="muted small">No matches.</div>'; return; }
    box.innerHTML = results.map((r, i) => `<button type="button" data-loc="${i}">${esc(r.label)}</button>`).join('');
    $$('[data-loc]', box).forEach((b) => {
      b.onclick = () => {
        pendingLoc = results[Number(b.dataset.loc)];
        $$('[data-loc]', box).forEach((x) => x.classList.toggle('on', x === b));
        $('#current-location').textContent = pendingLoc.label;
      };
    });
  } catch (e) { box.innerHTML = `<div class="muted small">${esc(e.message)}</div>`; }
}
async function saveSettings(e) {
  e.preventDefault();
  const f = e.target;
  const unit = segValue($('#unit-seg')) || 'C';
  const shown = Number(f.outerwear_below.value);
  // convert the threshold using the unit it was typed in
  const c = unit === 'F' ? (shown - 32) * 5 / 9 : shown;
  const body = { unit, outerwear_below: Math.round(c * 10) / 10, ai_prompt: f.ai_prompt.value, ai_model: f.ai_model.value,
    tryon_quality: f.tryon_quality.value };
  if (f.openai_key.value.trim()) body.openai_key = f.openai_key.value.trim();
  else if (removeKey) body.openai_key = '';
  if (pendingLoc) Object.assign(body, { location_name: pendingLoc.label, lat: pendingLoc.lat, lon: pendingLoc.lon });
  state.settings = await api('/api/settings', sendJSON('PUT', body));
  await loadConfig();
  $('#settings-dialog').close();
  toast('Settings saved');
  render();
}

let removeKey = false;

function showKeyStatus() {
  const s = state.settings;
  const el = $('#key-status');
  if (removeKey) {
    el.textContent = s.ai_key_source === 'env'
      ? 'Saved key will be removed; the key from the server’s .env file will be used.'
      : 'Saved key will be removed when you press Save.';
  } else if (s.ai_key_source === 'settings') el.textContent = `Saved (${s.ai_key_hint}). Type a new key to replace it.`;
  else if (s.ai_key_source === 'env') el.textContent = `Using the key from the server’s .env file (${s.ai_key_hint}). A key saved here takes priority.`;
  else el.textContent = 'Not set. AI features stay hidden until you add a key.';
  $('#remove-key-btn').hidden = s.ai_key_source !== 'settings' || removeKey;
}

async function testKey() {
  const f = $('#settings-form');
  const out = $('#test-result');
  const btn = $('#test-key-btn');
  btn.disabled = true;
  out.textContent = 'Testing…';
  try {
    const r = await api('/api/ai/test', sendJSON('POST', { openai_key: f.openai_key.value.trim(), ai_model: f.ai_model.value.trim() }));
    out.textContent = `✓ Works with ${r.model}`;
  } catch (e) {
    out.textContent = `✗ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- data ----------
const PAGE_VERSION = document.querySelector('meta[name="app-version"]')?.content || '';

// After an update the server has a newer version: load it (once), instead of running old code.
function reloadIfOutdated(serverVersion) {
  if (!serverVersion || !PAGE_VERSION || serverVersion === PAGE_VERSION) return false;
  let tried = '';
  try { tried = sessionStorage.getItem('reloaded-for') || ''; } catch { /* private mode */ }
  if (tried === serverVersion) return false;
  try { sessionStorage.setItem('reloaded-for', serverVersion); } catch { /* ignore */ }
  window.location.reload();
  return true;
}

async function loadConfig() {
  const cfg = await api('/api/config');
  if (reloadIfOutdated(cfg.version)) return;
  $('#app-version').textContent = `App version ${cfg.version || PAGE_VERSION || '?'}`;
  state.ai = cfg.ai_enabled;
  state.cutout = cfg.cutout_enabled;
  state.kinds = cfg.kinds || {};
  state.layerKinds = cfg.layer_kinds || [];
  $('#outfits-tab').hidden = !(cfg.ai_enabled || cfg.saved_count || cfg.discarded_count || cfg.idea_count);
}
async function loadItems() { state.items = await api('/api/items?include_archived=true'); }

// ---------- wire up ----------
function init() {
  $$('.tabbar button').forEach((b) => { b.onclick = () => show(b.dataset.view); });
  $('#settings-btn').onclick = openSettings;
  const closeDialog = (d) => { if (d.id !== 'bulk-dialog') d.close(); else if (!bulk.saving) closeBulk(); };
  $$('dialog [data-close]').forEach((b) => { b.onclick = () => closeDialog(b.closest('dialog')); });
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) closeDialog(d); }));
  bindBulk();
  bindPageDrop();

  bindSeg($('#occasion-seg'), (v) => { state.occasion = Number(v); state.shuffle = 0; renderToday(); });
  bindSeg($('#day-seg'), (v) => { state.day = Number(v); state.shuffle = 0; renderToday(); });
  $('#shuffle-btn').onclick = () => { state.shuffle += 1; renderToday(); };
  $('#suggestions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-wear]');
    if (b && !b.disabled) wear(state.today[Number(b.dataset.wear)], b);
  });

  $('#search').addEventListener('input', (e) => { state.search = e.target.value; renderCloset(); });
  $('#add-item-btn').onclick = () => openItem();
  $('#cat-chips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-f]');
    if (c) { state.filter = c.dataset.f; state.kindFilter = ''; renderCloset(); }
  });
  $('#kind-chips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-k]');
    if (c) { state.kindFilter = c.dataset.k; renderCloset(); }
  });
  $('#closet-grid').addEventListener('click', (e) => {
    const lb = e.target.closest('[data-laundry]');
    if (lb) { e.stopPropagation(); toggleLaundry(Number(lb.dataset.laundry)); return; }
    const card = e.target.closest('[data-id]');
    if (card) openItem(state.items.find((i) => i.id === Number(card.dataset.id)));
  });
  $('#closet-grid').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-id]')) openItem(state.items.find((i) => i.id === Number(e.target.dataset.id)));
  });

  // item form
  const f = $('#item-form');
  f.category.innerHTML = CATS.map(([k]) => `<option value="${k}">${SINGULAR[k]}</option>`).join('');
  f.warmth.addEventListener('input', () => { $('#warmth-label').textContent = WARMTH[f.warmth.value]; });
  f.category.addEventListener('change', () => updateKindOptions());
  f.match_id.addEventListener('change', updatePairOnly);
  bindSeg($('#formality-seg'), () => {});
  f.photo.addEventListener('change', () => { if (f.photo.files[0]) usePhoto(f.photo.files[0]); });
  dropTarget($('#photo-preview'), (files) => usePhoto(files[0]));
  // a drop anywhere else in the form counts too
  $('#item-dialog').addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  $('#item-dialog').addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const files = imageFiles(e.dataTransfer.files);
    if (files.length) usePhoto(files[0]); else toast('That isn’t a photo.');
  });
  $('#remove-photo-btn').onclick = () => { pendingPhoto = null; removePhoto = true; f.photo.value = ''; setPreview(null); updateAIButtons(); };
  $('#ai-fill-btn').onclick = aiFill;
  $('#import-btn').onclick = importFromUrl;
  $('#cutout-btn').onclick = () => photoAction('cutout');
  $('#restore-btn').onclick = () => photoAction('restore');
  $('#cleanup-btn').onclick = cleanupAllPhotos;
  const brandInput = f.brand;
  brandInput.addEventListener('input', showBrands);
  brandInput.addEventListener('focus', showBrands);
  brandInput.addEventListener('blur', () => setTimeout(hideBrands, 150));
  brandInput.addEventListener('keydown', (e) => {
    const open = !$('#brand-list').hidden;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) showBrands(); highlightBrand(1); }
    else if (e.key === 'ArrowUp' && open) { e.preventDefault(); highlightBrand(-1); }
    else if (e.key === 'Enter' && open && combo.idx >= 0) { e.preventDefault(); pickBrand(combo.idx); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); hideBrands(); }
  });
  $('#brand-list').addEventListener('pointerdown', (e) => {
    const opt = e.target.closest('[data-i]');
    if (!opt) return;
    e.preventDefault(); // keep focus in the field
    pickBrand(Number(opt.dataset.i));
  });
  $('#import-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); importFromUrl(); } });
  $('#build-btn').onclick = () => {
    const it = editing;
    $('#item-dialog').close();
    runAI({ anchor_id: it.id });
  };

  // outfits tab
  $('#ai-create-btn').onclick = () => runAI({ note: $('#ai-note').value.trim() });
  $('#ai-note').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#ai-create-btn').click(); } });
  bindSeg($('#lib-seg'), (v) => { libView.tab = v; libView.reviewHold = null; renderOutfits(); window.scrollTo({ top: 0 }); });
  $('#new-outfit-btn').onclick = chooseCreate;
  $('#viewer-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cact]');
    if (!b || e.target.closest('input')) return;
    const note = $('#create-note')?.value.trim() || '';
    $('#viewer').close();
    if (b.dataset.cact === 'ai') runAI({ note });
    else openLog(null, 'lib-new');
  });
  $('#viewer').addEventListener('close', () => { detailId = null; });
  $('#lib-occ').addEventListener('click', (e) => {
    const b = e.target.closest('[data-occ]');
    if (!b) return;
    libView.occ = Number(b.dataset.occ);
    $$('#lib-occ .chip').forEach((x) => x.classList.toggle('on', x === b));
    renderOutfits();
  });
  $('#lib-season').addEventListener('click', (e) => {
    const b = e.target.closest('[data-season]');
    if (!b) return;
    libView.season = b.dataset.season;
    $$('#lib-season .chip').forEach((x) => x.classList.toggle('on', x === b));
    renderOutfits();
  });
  $('#lib-sort').addEventListener('change', (e) => { libView.sort = e.target.value; renderOutfits(); });
  f.addEventListener('submit', saveItem);
  $('#archive-btn').onclick = archiveItem;
  $('#delete-btn').onclick = deleteItem;

  // history
  $('#log-outfit-btn').onclick = () => openLog();
  $('#history-list').addEventListener('click', async (e) => {
    const rate = e.target.closest('[data-rate]');
    const del = e.target.closest('[data-del]');
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      openLog(state.history.find((o) => o.id === Number(edit.dataset.edit)), 'history');
    } else if (rate) {
      const card = rate.closest('[data-outfit]');
      const n = Number(rate.dataset.rate);
      await api(`/api/outfits/${card.dataset.outfit}`, sendJSON('PATCH', { rating: n }));
      $$('[data-rate]', card).forEach((b) => b.classList.toggle('on', Number(b.dataset.rate) <= n));
    } else if (del) {
      if (!confirm('Remove this outfit from your history?')) return;
      await api(`/api/outfits/${del.dataset.del}`, { method: 'DELETE' });
      await loadItems();
      renderHistory();
    }
  });
  $('#picker').addEventListener('click', (e) => {
    const p = e.target.closest('[data-pick]');
    if (!p) return;
    const id = Number(p.dataset.pick);
    if (picked.has(id)) picked.delete(id); else picked.add(id);
    p.classList.toggle('on', picked.has(id));
    updatePickCount();
  });
  $('#log-stars').addEventListener('click', (e) => {
    const s = e.target.closest('[data-star]');
    if (!s) return;
    const n = Number(s.dataset.star);
    logRating = logRating === n ? 0 : n;
    $$('[data-star]', $('#log-stars')).forEach((b) => b.classList.toggle('on', Number(b.dataset.star) <= logRating));
  });
  $('#log-form').addEventListener('submit', saveLog);
  $('#name-ai-btn').onclick = async () => {
    if (!picked.size) { toast('Pick the pieces first.'); return; }
    const btn = $('#name-ai-btn');
    const f = $('#log-form');
    btn.disabled = true;
    btn.textContent = 'Thinking…';
    try {
      const r = await api('/api/ai/name', sendJSON('POST', { item_ids: [...picked], occasion: Number(f.occasion.value), notes: f.notes.value }));
      $('#name-ideas').innerHTML = r.names.map((n) => `<button type="button" class="chip" data-name="${esc(n)}">${esc(n)}</button>`).join('');
    } catch (e) { toast(e.message); }
    btn.disabled = false;
    btn.textContent = '✨ Suggest';
  };
  $('#name-ideas').addEventListener('click', (e) => {
    const c = e.target.closest('[data-name]');
    if (!c) return;
    $('#log-form').outfit_name.value = c.dataset.name;
    $$('#name-ideas .chip').forEach((x) => x.classList.toggle('on', x === c));
  });

  // settings
  bindSeg($('#unit-seg'), (v) => {
    // convert the threshold field so it keeps meaning the same temperature
    const field = $('#settings-form').outerwear_below;
    const was = $('#thresh-unit').textContent.slice(1);
    const cur = Number(field.value);
    if (was !== v && field.value !== '' && !Number.isNaN(cur)) {
      field.value = Math.round(v === 'F' ? cur * 9 / 5 + 32 : (cur - 32) * 5 / 9);
    }
    $('#thresh-unit').textContent = `°${v}`;
  });
  $('#loc-search-btn').onclick = searchLocation;
  $('#loc-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchLocation(); } });
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#rule-type').addEventListener('change', () => updateRuleBuilder());
  $('#rule-category').addEventListener('change', () => updateRuleBuilder());
  $('#rule-occasion').addEventListener('change', updateRulePreview);
  $('#rule-temp-mode').addEventListener('change', () => updateRuleBuilder(true));
  $('#rule-temp').addEventListener('input', updateRulePreview);
  $('#rule-kinds').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    b.classList.toggle('on');
    updateRulePreview();
  });
  $('#rule-add-btn').onclick = addRule;
  $('#menswear-toggle').addEventListener('change', async (e) => {
    try {
      state.settings = await api('/api/settings', sendJSON('PUT', { menswear: e.target.checked }));
      toast(e.target.checked ? 'Classic menswear rules on' : 'Classic menswear rules off');
      if (state.view === 'today') renderToday();
    } catch (err) { toast(err.message); }
  });
  $$('[data-tryon]').forEach((input) => {
    input.addEventListener('change', () => { if (input.files[0]) uploadTryon(input.dataset.tryon, input.files[0]); input.value = ''; });
    dropTarget(input.nextElementSibling, (files) => uploadTryon(input.dataset.tryon, files[0]));
  });
  $$('[data-remove-tryon]').forEach((b) => {
    b.onclick = async () => {
      try {
        state.settings = await api(`/api/tryon/photo/${b.dataset.removeTryon}`, { method: 'DELETE' });
        renderTryonPhotos();
        toast('Photo removed');
      } catch (e) { toast(e.message); }
    };
  });
  // outfit tools and the viewer
  document.addEventListener('click', onOutfitTool);
  $('#viewer-body').addEventListener('click', async (e) => {
    const star = e.target.closest('[data-orate]');
    if (!star) return;
    const o = getOutfit('lib', Number(star.closest('[data-orate-for]').dataset.orateFor));
    if (!o) return;
    const n = Number(star.dataset.orate);
    const rating = o.rating === n ? 0 : n; // tap the same star again to clear
    if (await libPatch(o, { rating })) {
      refreshDetail(o.id);
      renderOutfits();
    }
  });
  ['#viewer-foot', '#viewer-body'].forEach((sel) => $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('[data-vact]');
    if (b) viewerAction(b.dataset.vact, b);
  }));
  $('#check-photo-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file && checkTarget) checkNewPhoto(file);
  });
  $('#outfit-photo-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file && photoTarget) uploadOutfitPhoto(photoTarget.kind, photoTarget.id, file);
  });

  $('#rules-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del-rule]');
    if (!b) return;
    const rules = [...(state.settings.rules || [])];
    rules.splice(Number(b.dataset.delRule), 1);
    saveRules(rules, 'Rule removed');
  });
  $('#test-key-btn').onclick = testKey;
  $('#remove-key-btn').onclick = () => { removeKey = true; $('#settings-form').openai_key.value = ''; showKeyStatus(); };
}

// iOS ignores user-scalable=no; block pinch and double-tap zoom so the app keeps its layout
['gesturestart', 'gesturechange'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
document.addEventListener('touchmove', (e) => { if (e.scale !== undefined && e.scale !== 1) e.preventDefault(); }, { passive: false });

// a home-screen app can sit in the background for days: check for an update when it comes back
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  try { reloadIfOutdated((await api('/api/config')).version); } catch { /* offline: keep going */ }
});

(async function start() {
  init();
  try {
    [state.settings] = await Promise.all([api('/api/settings'), loadConfig(), loadItems()]);
    await loadLibrary();
  } catch (e) {
    toast(`Couldn't reach the server: ${e.message}`);
  }
  show(state.view); // stay where the user already tapped while loading
}());
