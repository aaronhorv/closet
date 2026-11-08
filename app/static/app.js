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
  if (q) list = list.filter((i) => [i.name, i.color, i.color2, i.brand, i.material, i.pattern, i.tags, i.notes].join(' ').toLowerCase().includes(q));
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
  ['material', 'fit', 'pattern', 'color2'].forEach((k) => fd.append(k, f[k].value));
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

// ---------- filling the item form (AI / shop link) ----------
const FORM_KEYS = ['name', 'category', 'color', 'color2', 'pattern', 'material', 'fit', 'brand', 'tags'];

function fillItemForm(d, overwrite) {
  const f = $('#item-form');
  FORM_KEYS.forEach((k) => {
    if (d[k] === undefined || d[k] === null) return;
    if (!overwrite && !d[k]) return; // don't blank out what the user typed
    f[k].value = d[k];
  });
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
    ['color', 'color2', 'pattern', 'material', 'fit', 'brand'].forEach((k) => { if (f[k]) fd.append(k, f[k]); });
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
  const body = { unit, outerwear_below: Math.round(c * 10) / 10, ai_prompt: f.ai_prompt.value, ai_model: f.ai_model.value };
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
async function loadConfig() {
  const cfg = await api('/api/config');
  state.ai = cfg.ai_enabled;
  state.cutout = cfg.cutout_enabled;
  $('#outfits-tab').hidden = !(cfg.ai_enabled || cfg.saved_count);
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
  $('#test-key-btn').onclick = testKey;
  $('#remove-key-btn').onclick = () => { removeKey = true; $('#settings-form').openai_key.value = ''; showKeyStatus(); };
}

(async function start() {
  init();
  try {
    [state.settings] = await Promise.all([api('/api/settings'), loadConfig(), loadItems()]);
  } catch (e) {
    toast(`Couldn't reach the server: ${e.message}`);
  }
  show('today');
}());
