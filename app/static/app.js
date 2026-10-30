'use strict';

const CATS = [
  ['top', 'Tops', '👕'], ['bottom', 'Bottoms', '👖'], ['dress', 'Dresses', '👗'],
  ['outerwear', 'Outerwear', '🧥'], ['shoes', 'Shoes', '👟'], ['accessory', 'Accessories', '👜'],
];
const CAT_LABEL = Object.fromEntries(CATS.map(([k, l]) => [k, l]));
const CAT_ICON = Object.fromEntries(CATS.map(([k, , i]) => [k, i]));
const SINGULAR = { top: 'Top', bottom: 'Bottom', dress: 'Dress / one-piece', outerwear: 'Outerwear', shoes: 'Shoes', accessory: 'Accessory' };
const OCCASIONS = { 1: 'Casual', 2: 'Smart casual', 3: 'Formal' };
const WARMTH = ['', 'Very light', 'Light', 'Medium', 'Warm', 'Very warm'];
const ORDER = ['outerwear', 'top', 'dress', 'bottom', 'shoes', 'accessory'];
const TITLES = { today: 'Today', closet: 'Closet', history: 'History', outfits: 'Outfits' };

const state = {
  view: 'today', items: [], settings: { unit: 'C' },
  occasion: 2, day: 0, shuffle: 0,
  filter: 'all', search: '',
  ai: false, aiResults: null, saved: [],
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch { /* not json */ }
    throw new Error(typeof msg === 'string' ? msg : 'Request failed');
  }
  return res.json();
}
const sendJSON = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function toast(msg) {
  const t = $('#toast');
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
  const done = state.day === 0 ? 'Wear this' : 'Plan this';
  box.innerHTML = res.outfits.map((o, i) => `
    <article class="card outfit">
      <div class="outfit-items">
        ${o.items.map((it) => `<figure>${thumb(it)}<figcaption>${esc(it.name)}</figcaption></figure>`).join('')}
      </div>
      ${o.notes.length ? `<ul class="notes">${o.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <button class="btn primary" data-wear="${i}">${done}</button>
    </article>`).join('');
  $$('[data-wear]', box).forEach((b) => {
    b.onclick = () => wear(res.outfits[Number(b.dataset.wear)], b);
  });
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
  btn.disabled = true;
  try {
    await api('/api/outfits', sendJSON('POST', {
      item_ids: outfit.items.map((i) => i.id), worn_on: dayDate(state.day), occasion: state.occasion,
    }));
    btn.textContent = 'Logged ✓';
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
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter((i) => [i.name, i.color, i.brand, i.tags, i.notes].join(' ').toLowerCase().includes(q));
  list = [...list].sort(byOrder);

  const grid = $('#closet-grid');
  if (!state.items.length) {
    grid.innerHTML = `<div class="card empty" style="grid-column:1/-1">
      <div><strong>Your closet is empty</strong></div>
      <div>Add a few tops, bottoms and shoes and you'll get outfit ideas on the Today tab.</div>
      <button class="btn primary" id="empty-add">Add your first item</button></div>`;
    $('#empty-add').onclick = () => openItem();
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
        <div class="item-name">${esc(it.name)}</div>
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

function openItem(it = null) {
  editing = it;
  pendingPhoto = null;
  removePhoto = false;
  const f = $('#item-form');
  f.reset();
  $('#item-dialog-title').textContent = it ? 'Edit item' : 'Add item';
  f.name.value = it?.name || '';
  f.category.value = it?.category || (CAT_LABEL[state.filter] ? state.filter : 'top');
  f.color.value = it?.color || '';
  f.warmth.value = it?.warmth || 3;
  $('#warmth-label').textContent = WARMTH[f.warmth.value];
  setSeg($('#formality-seg'), it?.formality || 2);
  f.brand.value = it?.brand || '';
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
  fd.append('tags', f.tags.value);
  fd.append('notes', f.notes.value);
  fd.append('favorite', f.favorite.checked ? 'true' : 'false');
  if (pendingPhoto) fd.append('photo', pendingPhoto);
  if (removePhoto && !pendingPhoto) fd.append('remove_photo', 'true');

  const btn = $('#item-save-btn');
  btn.disabled = true;
  try {
    await api(editing ? `/api/items/${editing.id}` : '/api/items', { method: editing ? 'PUT' : 'POST', body: fd });
    $('#item-dialog').close();
    toast(editing ? 'Saved' : 'Added to your closet');
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
  if (!outfits.length) {
    box.innerHTML = '<div class="card empty">No outfits logged yet. Tap “Wear this” on the Today tab or log one here.</div>';
    return;
  }
  let html = '';
  let last = null;
  for (const o of outfits) {
    if (o.worn_on !== last) { html += `<div class="day-label">${esc(dayLabel(o.worn_on))}</div>`; last = o.worn_on; }
    html += `
      <article class="card hist" data-outfit="${o.id}">
        <div class="hist-top">
          <div class="stars" aria-label="Rating">${starsHTML(o.rating || 0, 'data-rate')}</div>
          <div><span class="muted small">${esc(OCCASIONS[o.occasion] || '')}</span>
          <button class="icon-btn" data-del="${o.id}" aria-label="Delete outfit" title="Delete">✕</button></div>
        </div>
        <div class="hist-items">${o.items.map((it) => thumb(it, 'sm')).join('')}</div>
        <div class="hist-names">${o.items.map((it) => esc(it.name)).join(' · ')}</div>
      </article>`;
  }
  box.innerHTML = html;
}

// ---------- log outfit ----------
let picked = new Set();
let logRating = 0;

function openLog() {
  picked = new Set();
  logRating = 0;
  const f = $('#log-form');
  f.worn_on.value = dayDate(0);
  f.occasion.value = String(state.occasion);
  $('#log-stars').innerHTML = starsHTML(0, 'data-star');
  const active = state.items.filter((i) => !i.archived);
  $('#picker').innerHTML = active.length ? CATS.map(([k, label]) => {
    const its = active.filter((i) => i.category === k).sort(byOrder);
    if (!its.length) return '';
    return `<div><h4>${label}</h4><div class="picker-grid">${its.map((it) =>
      `<button type="button" class="pick" data-pick="${it.id}">${thumb(it)}<span>${esc(it.name)}</span></button>`).join('')}</div></div>`;
  }).join('') : '<div class="muted">Add items to your closet first.</div>';
  updatePickCount();
  $('#log-dialog').showModal();
}
function updatePickCount() {
  $('#pick-count').textContent = picked.size ? `${picked.size} piece${picked.size > 1 ? 's' : ''} selected` : 'Tap the pieces you wore.';
}
async function saveLog(e) {
  e.preventDefault();
  if (!picked.size) { toast('Pick at least one piece'); return; }
  const f = e.target;
  try {
    await api('/api/outfits', sendJSON('POST', {
      item_ids: [...picked], worn_on: f.worn_on.value, occasion: Number(f.occasion.value), rating: logRating || null,
    }));
    $('#log-dialog').close();
    toast('Outfit logged');
    await loadItems();
    render();
  } catch (err) { toast(err.message); }
}

// ---------- OUTFITS (saved + AI) ----------
function outfitCard(o, idx, kind) {
  const head = (o.name || kind === 'saved') ? `
    <div class="outfit-head"><h3>${esc(o.name || 'Outfit')}</h3>
      ${kind === 'saved' ? `<button class="icon-btn" data-del-saved="${o.id}" aria-label="Delete outfit" title="Delete">✕</button>` : ''}</div>` : '';
  const unavailable = o.items.filter((it) => it.in_laundry || it.archived);
  const notes = [o.notes || o.reason, unavailable.length ? `Not available now: ${unavailable.map((it) => it.name).join(', ')}` : '']
    .filter(Boolean);
  const save = kind === 'ai' ? `<button class="btn" data-save="${idx}" ${o.saved ? 'disabled' : ''}>${o.saved ? 'Saved ✓' : 'Save'}</button>` : '';
  return `
    <article class="card outfit">
      ${head}
      <div class="outfit-items">
        ${o.items.map((it) => `<figure class="${it.in_laundry || it.archived ? 'dirty' : ''}">${thumb(it)}<figcaption>${esc(it.name)}</figcaption></figure>`).join('')}
      </div>
      ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <div class="outfit-actions">${save}<button class="btn primary" data-wear-${kind}="${idx}">Wear this</button></div>
    </article>`;
}

function renderAIResults() {
  const box = $('#ai-results');
  const r = state.aiResults;
  if (!r) { box.innerHTML = ''; return; }
  if (r.loading) { box.innerHTML = `<div class="loading">${esc(r.label)}…</div>`; return; }
  if (r.error) {
    box.innerHTML = `<div class="card empty"><div>${esc(r.error)}</div><button class="btn" id="ai-dismiss">OK</button></div>`;
    $('#ai-dismiss').onclick = () => { state.aiResults = null; renderAIResults(); };
    return;
  }
  box.innerHTML = `<div class="section-label">${esc(r.label)}</div>${r.outfits.map((o, i) => outfitCard(o, i, 'ai')).join('')}`;
}

async function renderSaved() {
  const box = $('#saved-list');
  let saved;
  try { saved = await api('/api/saved'); } catch (e) { box.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
  state.saved = saved;
  if (!saved.length) {
    box.innerHTML = `<div class="section-label">Saved outfits</div><div class="card empty">${state.ai
      ? 'No saved outfits yet. Create some above, or open an item in your closet and tap “Build outfits with this”.'
      : 'No saved outfits.'}</div>`;
    return;
  }
  box.innerHTML = `<div class="section-label">Saved outfits</div>${saved.map((o, i) => outfitCard(o, i, 'saved')).join('')}`;
}

function renderOutfits() {
  $('#ai-create').hidden = !state.ai;
  renderAIResults();
  renderSaved();
}

async function runAI(body, label) {
  state.aiResults = { loading: true, label: 'Asking the AI' };
  renderAIResults();
  try {
    const r = await api('/api/ai/outfits', sendJSON('POST', body));
    state.aiResults = { label, outfits: r.outfits };
  } catch (e) {
    state.aiResults = { error: e.message };
  }
  if (state.view === 'outfits') renderAIResults();
}

async function wearOutfit(o, btn) {
  btn.disabled = true;
  const forms = o.items.map((i) => i.formality);
  try {
    await api('/api/outfits', sendJSON('POST', {
      item_ids: o.items.map((i) => i.id), worn_on: dayDate(0),
      occasion: Math.round(forms.reduce((a, b) => a + b, 0) / forms.length) || 2,
    }));
    btn.textContent = 'Logged ✓';
    toast('Logged. Rate it later in History.');
    await loadItems();
  } catch (e) {
    btn.disabled = false;
    toast(e.message);
  }
}

async function saveAIOutfit(o, btn) {
  btn.disabled = true;
  try {
    await api('/api/saved', sendJSON('POST', { item_ids: o.items.map((i) => i.id), name: o.name, notes: o.reason }));
    o.saved = true;
    btn.textContent = 'Saved ✓';
    renderSaved();
  } catch (e) {
    btn.disabled = false;
    toast(e.message);
  }
}

// ---------- AI item fill ----------
function updateAIButtons() {
  const hasPhoto = !!pendingPhoto || (!!editing?.photo_url && !removePhoto);
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
    const f = $('#item-form');
    f.name.value = d.name;
    f.category.value = d.category;
    f.color.value = d.color;
    f.warmth.value = d.warmth;
    $('#warmth-label').textContent = WARMTH[d.warmth];
    setSeg($('#formality-seg'), d.formality);
    f.tags.value = d.tags;
    toast('Filled in. Check the details, then save.');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Fill in with AI';
  }
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
  $('#ai-prompt-field').hidden = !state.ai;
  f.ai_prompt.value = s.ai_prompt || '';
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
  const body = { unit, outerwear_below: Math.round(c * 10) / 10 };
  if (state.ai) body.ai_prompt = f.ai_prompt.value;
  if (pendingLoc) Object.assign(body, { location_name: pendingLoc.label, lat: pendingLoc.lat, lon: pendingLoc.lon });
  state.settings = await api('/api/settings', sendJSON('PUT', body));
  $('#settings-dialog').close();
  toast('Settings saved');
  render();
}

// ---------- data ----------
async function loadItems() { state.items = await api('/api/items?include_archived=true'); }

// ---------- wire up ----------
function init() {
  $$('.tabbar button').forEach((b) => { b.onclick = () => show(b.dataset.view); });
  $('#settings-btn').onclick = openSettings;
  $$('dialog [data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  bindSeg($('#occasion-seg'), (v) => { state.occasion = Number(v); state.shuffle = 0; renderToday(); });
  bindSeg($('#day-seg'), (v) => { state.day = Number(v); state.shuffle = 0; renderToday(); });
  $('#shuffle-btn').onclick = () => { state.shuffle += 1; renderToday(); };

  $('#search').addEventListener('input', (e) => { state.search = e.target.value; renderCloset(); });
  $('#add-item-btn').onclick = () => openItem();
  $('#cat-chips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-f]');
    if (c) { state.filter = c.dataset.f; renderCloset(); }
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
  bindSeg($('#formality-seg'), () => {});
  f.photo.addEventListener('change', () => {
    const file = f.photo.files[0];
    if (!file) return;
    pendingPhoto = file;
    removePhoto = false;
    setPreview(URL.createObjectURL(file));
    updateAIButtons();
  });
  $('#remove-photo-btn').onclick = () => { pendingPhoto = null; removePhoto = true; f.photo.value = ''; setPreview(null); updateAIButtons(); };
  $('#ai-fill-btn').onclick = aiFill;
  $('#build-btn').onclick = () => {
    const it = editing;
    $('#item-dialog').close();
    show('outfits');
    runAI({ anchor_id: it.id }, `Outfits with your ${it.name}`);
  };

  // outfits tab
  $('#ai-create-btn').onclick = () => {
    const note = $('#ai-note').value.trim();
    runAI({ note }, note ? `New outfits: ${note}` : 'New outfits from your closet');
  };
  $('#ai-note').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#ai-create-btn').click(); } });
  $('#ai-results').addEventListener('click', (e) => {
    const outfits = state.aiResults?.outfits || [];
    const w = e.target.closest('[data-wear-ai]');
    const sv = e.target.closest('[data-save]');
    if (w) wearOutfit(outfits[Number(w.dataset.wearAi)], w);
    else if (sv) saveAIOutfit(outfits[Number(sv.dataset.save)], sv);
  });
  $('#saved-list').addEventListener('click', async (e) => {
    const w = e.target.closest('[data-wear-saved]');
    const d = e.target.closest('[data-del-saved]');
    if (w) wearOutfit(state.saved[Number(w.dataset.wearSaved)], w);
    else if (d) {
      if (!confirm('Delete this saved outfit?')) return;
      await api(`/api/saved/${d.dataset.delSaved}`, { method: 'DELETE' });
      renderSaved();
    }
  });
  f.addEventListener('submit', saveItem);
  $('#archive-btn').onclick = archiveItem;
  $('#delete-btn').onclick = deleteItem;

  // history
  $('#log-outfit-btn').onclick = openLog;
  $('#history-list').addEventListener('click', async (e) => {
    const rate = e.target.closest('[data-rate]');
    const del = e.target.closest('[data-del]');
    if (rate) {
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
}

(async function start() {
  init();
  try {
    let cfg;
    [state.settings, cfg] = await Promise.all([api('/api/settings'), api('/api/config'), loadItems()]);
    state.ai = cfg.ai_enabled;
    $('#outfits-tab').hidden = !(cfg.ai_enabled || cfg.saved_count);
  } catch (e) {
    toast(`Couldn't reach the server: ${e.message}`);
  }
  show('today');
}());
