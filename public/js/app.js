'use strict';

// ─────────────────────────────────────────────────────────────
// CyberLab Tracker — on-prem client
// Same UI as the AWS build, rewired to /api/* with session
// cookies + double-submit CSRF instead of Cognito.
// ─────────────────────────────────────────────────────────────

let ME = null;          // current signed-in user
let usr = '';           // selected checkout user (name string)
let imageFiles = [];    // Files chosen for scan (up to 4)
let aiSource = false;   // whether current verify card came from AI
let cacheLog = [];      // last fetched activity log
let cacheUsers = [];    // last fetched admin user list (for search filter)
let cacheCI = [];       // last fetched check-in list (for search filter)
let cacheInv = [];      // last fetched inventory list
let invStatus = 'all';  // current inventory status filter
let _lastFocusedBeforeOverlay = null; // for restoring focus after closing overlays

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── HTTP helpers ──────────────────────────────────────────────
function getCookie(name) {
  const m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[2]) : null;
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const csrf = getCookie('csrf_token');
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const r = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || r.statusText || 'Request failed');
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(msg, type) {
  const el = $('toast');
  el.textContent = msg;
  el.style.borderColor =
    type === 'red' ? 'var(--red)' :
    type === 'green' ? 'var(--green)' :
    type === 'yellow' ? 'var(--yellow)' : 'var(--border)';
  el.style.display = 'block';
  // Make toasts announceable to screen readers
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  clearTimeout(window._tt);
  window._tt = setTimeout(() => (el.style.display = 'none'), 3200);
}

// ── Page switching ────────────────────────────────────────────
function swPage(p, fromPop) {
  // Non-admins can't see the log/inventory pages — bounce to checkout.
  const adminOnly = ['log', 'inventory'];
  if (adminOnly.includes(p) && (!ME || ME.role !== 'admin')) p = 'checkout';
  $('backBtn').style.display = p === 'checkout' ? 'none' : 'inline-block';
  if (!fromPop) history.pushState({ page: p }, '', location.href);
  ['checkout', 'checkin', 'inventory', 'log'].forEach((x) => {
    const pg = $('pg-' + x);
    const bt = $('bt-' + x);
    if (pg) pg.classList.toggle('on', x === p);
    if (bt) {
      bt.classList.toggle('on', x === p);
      bt.setAttribute('aria-selected', x === p ? 'true' : 'false');
    }
  });
  $('scr').scrollTop = 0;
  // Auto-load when entering tabs that need data
  if (p === 'checkin') loadCI();
  if (p === 'log') loadLog();
  if (p === 'inventory') loadInventory();
}
window.swPage = swPage;

window.addEventListener('popstate', (e) => swPage((e.state && e.state.page) || 'checkout', true));

// ── Checkout: entry mode ──────────────────────────────────────
function swMode(m) {
  $('scanMode').classList.toggle('hidden', m !== 'scan');
  $('manualMode').classList.toggle('hidden', m !== 'manual');
  const mtScan = $('mt-scan');
  const mtManual = $('mt-manual');
  mtScan.classList.toggle('on', m === 'scan');
  mtManual.classList.toggle('on', m === 'manual');
  mtScan.setAttribute('aria-pressed', m === 'scan' ? 'true' : 'false');
  mtManual.setAttribute('aria-pressed', m === 'manual' ? 'true' : 'false');
  $('vcard').classList.add('hidden');
}
window.swMode = swMode;

// ── Image picking + compression ───────────────────────────────
const MAX_IMAGES = 4;

function compressImage(file, cb) {
  const r = new FileReader();
  r.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1200;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      c.toBlob((blob) => cb(blob, c.toDataURL('image/jpeg', 0.75)), 'image/jpeg', 0.75);
    };
    img.src = ev.target.result;
  };
  r.readAsDataURL(file);
}

function renderImageGrid() {
  const grid = $('imgGrid');
  grid.innerHTML = '';
  imageFiles.forEach((entry, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'img-thumb';
    const img = document.createElement('img');
    img.src = entry.dataUrl;
    img.alt = `Selected image ${idx + 1}`;
    const rm = document.createElement('button');
    rm.className = 'img-rm';
    rm.type = 'button';
    rm.setAttribute('aria-label', `Remove image ${idx + 1}`);
    rm.textContent = '✕';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      imageFiles.splice(idx, 1);
      if (!imageFiles.length) { clearImg(); return; }
      renderImageGrid();
    });
    wrap.appendChild(img);
    wrap.appendChild(rm);
    grid.appendChild(wrap);
  });
  const addBtn = $('addMoreBtn');
  if (addBtn) addBtn.style.display = imageFiles.length >= MAX_IMAGES ? 'none' : '';
}

function addFiles(files) {
  const remaining = MAX_IMAGES - imageFiles.length;
  const toAdd = Array.from(files).slice(0, remaining);
  if (!toAdd.length) { toast(`Max ${MAX_IMAGES} images`, 'yellow'); return; }
  let processed = 0;
  toAdd.forEach((file) => {
    compressImage(file, (blob, dataUrl) => {
      imageFiles.push({
        file: new File([blob], `scan${imageFiles.length}.jpg`, { type: 'image/jpeg' }),
        dataUrl,
      });
      processed++;
      if (processed === toAdd.length) {
        renderImageGrid();
        $('imgPrev').classList.remove('hidden');
        $('dz').classList.add('hidden');
        $('vcard').classList.add('hidden');
      }
    });
  });
}

function handleFiles(e) {
  const files = e.target.files;
  if (!files || !files.length) return;
  addFiles(files);
}
window.handleFiles = handleFiles;

function addMore() {
  if (imageFiles.length >= MAX_IMAGES) { toast(`Max ${MAX_IMAGES} images`, 'yellow'); return; }
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.multiple = true;
  inp.addEventListener('change', (e) => addFiles(e.target.files));
  inp.click();
}
window.addMore = addMore;

function clearImg() {
  imageFiles = [];
  $('imgGrid').innerHTML = '';
  $('imgPrev').classList.add('hidden');
  $('dz').classList.remove('hidden');
  $('vcard').classList.add('hidden');
  $('scanSpin').classList.add('hidden');
  $('scanbtn').disabled = false;
}
window.clearImg = clearImg;

// ── AI scan ───────────────────────────────────────────────────
let _scanning = false;
async function doScan() {
  if (_scanning) { toast('Scan already in progress — please wait', 'yellow'); return; }
  if (!imageFiles.length) { toast('No images selected!', 'yellow'); return; }
  _scanning = true;
  $('scanSpin').classList.remove('hidden');
  $('scanbtn').disabled = true;
  const n = imageFiles.length;
  $('scanMsg').textContent = `Analyzing ${n} image${n > 1 ? 's' : ''} (local AI — can take 30-120s on CPU)...`;
  try {
    const fd = new FormData();
    imageFiles.forEach((entry) => fd.append('images', entry.file));
    const res = await api('/api/scan', { method: 'POST', body: fd });
    const r = res.result || {};
    popV({
      name: r.name || '',
      type: r.type || '',
      serial: r.serial || '',
      barcode: r.barcode || '',
      notes: '',
      confidence: typeof r.confidence === 'number' ? Math.round(r.confidence * 100) : null,
    }, true);
  } catch (err) {
    toast('Scan failed: ' + err.message, 'red');
  } finally {
    _scanning = false;
    $('scanSpin').classList.add('hidden');
    $('scanbtn').disabled = false;
  }
}
window.doScan = doScan;

// ── Manual entry ──────────────────────────────────────────────
function prepManual() {
  const n = $('m_name').value.trim();
  if (!n) { toast('Equipment name required!', 'yellow'); return; }
  popV({
    name: n,
    type: $('m_type').value.trim(),
    serial: $('m_serial').value.trim(),
    barcode: $('m_barcode').value.trim(),
    notes: $('m_notes').value.trim(),
    confidence: null,
  }, false);
}
window.prepManual = prepManual;

// ── Verify card ───────────────────────────────────────────────
function popV(d, fromAI) {
  $('v_name').value = d.name || '';
  $('v_type').value = d.type || '';
  $('v_serial').value = d.serial || '';
  $('v_barcode').value = d.barcode || '';
  $('v_notes').value = d.notes || '';
  $('v_user').textContent = usr;
  $('v_dt').textContent = new Date().toLocaleString();
  const cw = $('confW');
  const cfill = $('cfill');
  const clbl = $('clbl');
  cfill.classList.remove('high', 'mid', 'low');
  clbl.classList.remove('high', 'mid', 'low');
  if (fromAI && d.confidence != null) {
    cw.classList.remove('hidden');
    cfill.style.width = d.confidence + '%';
    let bucket, label;
    if (d.confidence >= 80) { bucket = 'high'; label = 'High confidence'; }
    else if (d.confidence >= 50) { bucket = 'mid'; label = 'Medium — double check'; }
    else { bucket = 'low'; label = 'Low — verify carefully'; }
    cfill.classList.add(bucket);
    clbl.classList.add(bucket);
    clbl.textContent = `${d.confidence}% — ${label}`;
  } else {
    cw.classList.add('hidden');
  }
  aiSource = fromAI;
  const vc = $('vcard');
  vc.classList.remove('hidden');
  setTimeout(() => vc.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}

function cancelV() { $('vcard').classList.add('hidden'); }
window.cancelV = cancelV;

// Look up an existing equipment row by barcode or serial.
// Returns the first matching item (server already trims/strips on input).
async function findExistingEquipment(barcode, serial) {
  if (!barcode && !serial) return null;
  try {
    // listAll returns all items the caller is allowed to see.
    // For non-admins this is only items they have checked out — that is
    // sufficient to detect a "duplicate" of their own item, but not to
    // reuse an admin-owned available item. The API returns items keyed
    // to the user's role, so this is the safest dedupe we can do client-side.
    const { items } = await api('/api/equipment');
    const list = items || [];
    const bc = (barcode || '').trim().toLowerCase();
    const sn = (serial || '').trim().toLowerCase();
    return list.find((i) => {
      const ibc = (i.barcode || '').trim().toLowerCase();
      const isn = (i.serial_number || '').trim().toLowerCase();
      return (bc && ibc === bc) || (sn && isn === sn);
    }) || null;
  } catch {
    return null;
  }
}

async function confirmCO() {
  const name = $('v_name').value.trim();
  if (!name) { toast('Equipment name required!', 'yellow'); return; }
  const payload = {
    name,
    type: $('v_type').value.trim(),
    serial_number: $('v_serial').value.trim(),
    barcode: $('v_barcode').value.trim(),
    notes: $('v_notes').value.trim(),
  };
  const btn = $('confbtn');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Saving...';
  try {
    let item;
    // Dedupe: if barcode or serial is provided and matches an existing
    // available item, reuse it instead of creating a duplicate row.
    const existing = await findExistingEquipment(payload.barcode, payload.serial_number);
    if (existing && existing.status === 'available') {
      item = existing;
    } else if (existing && existing.status === 'checked_out') {
      throw new Error(`"${existing.name}" with that ${payload.barcode ? 'barcode' : 'serial'} is already checked out`);
    } else {
      const created = await api('/api/equipment', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      item = created.item;
    }
    await api(`/api/equipment/${item.id}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ notes: payload.notes, source: aiSource ? 'Scan' : 'Manual' }),
    });
    toast('Checked out!', 'green');
    $('vcard').classList.add('hidden');
    clearImg();
    ['m_name', 'm_type', 'm_serial', 'm_barcode', 'm_notes'].forEach((id) => ($(id).value = ''));
    // Refresh tabs that may now be stale.
    if ($('pg-checkin').classList.contains('on')) loadCI();
    if ($('pg-inventory').classList.contains('on')) loadInventory();
  } catch (err) {
    toast('Error: ' + err.message, 'red');
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}
window.confirmCO = confirmCO;

// ── Check-in list ─────────────────────────────────────────────
async function loadCI() {
  const l = $('ciList');
  l.innerHTML = '<div class="sw"><div class="sp" aria-hidden="true"></div><span>Loading...</span></div>';
  try {
    const { items } = await api('/api/equipment?status=checked_out');
    let list = items || [];
    // Non-admins only see items they themselves checked out.
    if (ME && ME.role !== 'admin') {
      list = list.filter((e) => e.checked_out_by === ME.id);
    }
    cacheCI = list;
    renderCI(filteredCI());
  } catch (e) {
    l.innerHTML = `<div class="es es-err"><div class="ei" aria-hidden="true">⚠️</div><div class="et">${esc(e.message)}</div></div>`;
  }
}
window.loadCI = loadCI;

function filteredCI() {
  const q = (($('ciSearch') && $('ciSearch').value) || '').trim().toLowerCase();
  if (!q) return cacheCI;
  return cacheCI.filter((e) => {
    const fields = [e.name, e.type, e.serial_number, e.barcode, e.checked_out_username]
      .filter(Boolean).join(' ').toLowerCase();
    return fields.includes(q);
  });
}

function filterCI() { renderCI(filteredCI()); }
window.filterCI = filterCI;

function renderCI(items) {
  const l = $('ciList');
  if (!cacheCI.length) {
    l.innerHTML = '<div class="es"><div class="ei" aria-hidden="true">✅</div><div class="et">All equipment is checked in!</div></div>';
    return;
  }
  if (!items.length) {
    l.innerHTML = '<div class="es"><div class="ei" aria-hidden="true">🔎</div><div class="et">No matches for that search.</div></div>';
    return;
  }
  l.innerHTML = '';
  items.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'ci checked-out';
    const info = document.createElement('div');
    info.className = 'cin';
    const name = document.createElement('div');
    name.className = 'cname';
    name.textContent = e.name;
    const meta = document.createElement('div');
    meta.className = 'cmeta';
    const bits = [];
    if (e.type) bits.push(e.type);
    if (e.serial_number) bits.push('S/N: ' + e.serial_number);
    if (e.barcode) bits.push('BC: ' + e.barcode);
    if (e.checked_out_at) bits.push(new Date(e.checked_out_at).toLocaleString());
    meta.textContent = bits.join(' · ');
    if (e.checked_out_username) {
      const userTag = document.createElement('span');
      userTag.className = 'badge bwarn';
      userTag.style.marginLeft = '6px';
      userTag.textContent = e.checked_out_username;
      name.appendChild(document.createTextNode(' '));
      name.appendChild(userTag);
    }
    info.appendChild(name);
    info.appendChild(meta);
    const btn = document.createElement('button');
    btn.className = 'btn bg bsm';
    btn.type = 'button';
    btn.setAttribute('aria-label', `Check in ${e.name}`);
    btn.textContent = '📥 In';
    btn.addEventListener('click', () => doCI(e.id, e.name));
    row.appendChild(info);
    row.appendChild(btn);
    l.appendChild(row);
  });
}

async function doCI(id, name) {
  try {
    await api(`/api/equipment/${id}/checkin`, {
      method: 'POST',
      body: JSON.stringify({ source: 'Manual' }),
    });
    toast(`"${name}" checked in!`, 'green');
    await loadCI();
    if ($('pg-inventory').classList.contains('on')) loadInventory();
  } catch (e) {
    toast(e.message, 'red');
  }
}
window.doCI = doCI;

// ── Inventory (admin) ─────────────────────────────────────────
async function loadInventory() {
  if (!ME || ME.role !== 'admin') return;
  const l = $('invList');
  l.innerHTML = '<div class="sw"><div class="sp" aria-hidden="true"></div><span>Loading...</span></div>';
  try {
    const { items } = await api('/api/equipment');
    cacheInv = items || [];
    renderInventory();
  } catch (e) {
    l.innerHTML = `<div class="es es-err"><div class="ei" aria-hidden="true">⚠️</div><div class="et">${esc(e.message)}</div></div>`;
  }
}
window.loadInventory = loadInventory;

function setInvStatus(s) {
  invStatus = s;
  document.querySelectorAll('[data-inv-status]').forEach((c) => {
    const on = c.dataset.invStatus === s;
    c.classList.toggle('on', on);
    c.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  renderInventory();
}
window.setInvStatus = setInvStatus;

function filterInventory() { renderInventory(); }
window.filterInventory = filterInventory;

function renderInventory() {
  const l = $('invList');
  if (!cacheInv.length) {
    l.innerHTML = '<div class="es"><div class="ei" aria-hidden="true">📦</div><div class="et">No equipment yet.</div></div>';
    return;
  }
  const q = (($('invSearch') && $('invSearch').value) || '').trim().toLowerCase();
  let list = cacheInv;
  if (invStatus !== 'all') list = list.filter((i) => i.status === invStatus);
  if (q) {
    list = list.filter((e) => {
      const fields = [e.name, e.type, e.serial_number, e.barcode, e.checked_out_username]
        .filter(Boolean).join(' ').toLowerCase();
      return fields.includes(q);
    });
  }
  if (!list.length) {
    l.innerHTML = '<div class="es"><div class="ei" aria-hidden="true">🔎</div><div class="et">No items match.</div></div>';
    return;
  }
  l.innerHTML = '';
  list.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'ci ' + (e.status === 'checked_out' ? 'checked-out' : 'available');
    const info = document.createElement('div');
    info.className = 'cin';
    const name = document.createElement('div');
    name.className = 'cname';
    name.textContent = e.name;
    const status = document.createElement('span');
    status.className = 'badge ' + (e.status === 'checked_out' ? 'bout' : 'bavail');
    status.style.marginLeft = '6px';
    status.textContent = e.status === 'checked_out' ? 'OUT' : 'AVAIL';
    name.appendChild(document.createTextNode(' '));
    name.appendChild(status);
    const meta = document.createElement('div');
    meta.className = 'cmeta';
    const bits = [];
    if (e.type) bits.push(e.type);
    if (e.serial_number) bits.push('S/N: ' + e.serial_number);
    if (e.barcode) bits.push('BC: ' + e.barcode);
    if (e.status === 'checked_out' && e.checked_out_username) bits.push('with ' + e.checked_out_username);
    meta.textContent = bits.join(' · ');
    info.appendChild(name);
    info.appendChild(meta);
    row.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'ci-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'btn bo bsm';
    editBtn.type = 'button';
    editBtn.setAttribute('aria-label', `Edit ${e.name}`);
    editBtn.textContent = '✏️ Edit';
    editBtn.addEventListener('click', () => showEqEdit(e));
    actions.appendChild(editBtn);
    if (e.status === 'available') {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn br bsm';
      delBtn.type = 'button';
      delBtn.setAttribute('aria-label', `Delete ${e.name}`);
      delBtn.textContent = '🗑 Delete';
      delBtn.addEventListener('click', () => confirmDeleteEq(e));
      actions.appendChild(delBtn);
    } else {
      const ciBtn = document.createElement('button');
      ciBtn.className = 'btn bg bsm';
      ciBtn.type = 'button';
      ciBtn.setAttribute('aria-label', `Check in ${e.name}`);
      ciBtn.textContent = '📥 In';
      ciBtn.addEventListener('click', () => doCI(e.id, e.name));
      actions.appendChild(ciBtn);
    }
    row.appendChild(actions);
    l.appendChild(row);
  });
}

async function confirmDeleteEq(e) {
  if (!confirm(`Permanently delete "${e.name}"? This cannot be undone.`)) return;
  try {
    await api(`/api/equipment/${e.id}`, { method: 'DELETE' });
    toast('Deleted', 'green');
    loadInventory();
  } catch (err) {
    toast(err.message, 'red');
  }
}

function showEqEdit(e) {
  _lastFocusedBeforeOverlay = document.activeElement;
  $('eqEditId').value = e.id;
  $('eqEditName').value = e.name || '';
  $('eqEditType').value = e.type || '';
  $('eqEditSerial').value = e.serial_number || '';
  $('eqEditBarcode').value = e.barcode || '';
  $('eqEditNotes').value = e.notes || '';
  $('eqEditErr').textContent = '';
  $('eqEditOv').classList.remove('hidden');
  setTimeout(() => $('eqEditName').focus(), 30);
}
window.showEqEdit = showEqEdit;

function hideEqEdit() {
  $('eqEditOv').classList.add('hidden');
  if (_lastFocusedBeforeOverlay && _lastFocusedBeforeOverlay.focus) {
    _lastFocusedBeforeOverlay.focus();
  }
}
window.hideEqEdit = hideEqEdit;

async function saveEqEdit() {
  const id = parseInt($('eqEditId').value, 10);
  const name = $('eqEditName').value.trim();
  if (!name) { $('eqEditErr').textContent = 'Name is required'; return; }
  const payload = {
    name,
    type: $('eqEditType').value.trim(),
    serial_number: $('eqEditSerial').value.trim(),
    barcode: $('eqEditBarcode').value.trim(),
    notes: $('eqEditNotes').value.trim(),
  };
  try {
    await api(`/api/equipment/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    toast('Saved', 'green');
    hideEqEdit();
    loadInventory();
  } catch (err) {
    $('eqEditErr').textContent = err.message || 'Failed';
  }
}
window.saveEqEdit = saveEqEdit;

// ── Activity log ──────────────────────────────────────────────
async function clearLog() {
  if (!confirm('Clear the entire activity log? This cannot be undone.')) return;
  try {
    await api('/api/equipment/log', { method: 'DELETE' });
    toast('Log cleared', 'green');
    loadLog();
  } catch (e) {
    toast(e.message, 'red');
  }
}
window.clearLog = clearLog;

async function loadLog() {
  const clb = $('clearLogBtn');
  if (clb) clb.style.display = (ME && ME.role === 'admin') ? '' : 'none';
  const w = $('logW');
  w.innerHTML = '<div class="sw"><div class="sp" aria-hidden="true"></div><span>Loading...</span></div>';
  try {
    const { entries } = await api('/api/equipment/log');
    cacheLog = entries || [];
    if (!cacheLog.length) {
      w.innerHTML = '<div class="es"><div class="ei" aria-hidden="true">📋</div><div class="et">No entries yet.</div></div>';
      return;
    }
    let html = '<div class="ls"><table><thead><tr><th scope="col">Action</th><th scope="col">Equipment</th><th scope="col">S/N · BC</th><th scope="col">User</th><th scope="col">When</th></tr></thead><tbody>';
    cacheLog.forEach((e) => {
      const badge = e.action === 'checkout'
        ? '<span class="badge bout" aria-label="Check out">OUT</span>'
        : '<span class="badge bin" aria-label="Check in">IN</span>';
      const sn = e.serial_number ? 'S/N: ' + esc(e.serial_number) : '<span style="color:var(--muted)">—</span>';
      html += `<tr>
        <td>${badge}</td>
        <td><strong>${esc(e.equipment_name || '')}</strong></td>
        <td class="mono small">${sn}</td>
        <td class="accent bold">${esc(e.checkout_user || '')}</td>
        <td class="mono small" style="color:var(--muted-strong)">${esc(new Date(e.created_at).toLocaleString())}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    w.innerHTML = html;
  } catch (e) {
    w.innerHTML = `<div class="es es-err"><div class="ei" aria-hidden="true">⚠️</div><div class="et">${esc(e.message)}</div></div>`;
  }
}
window.loadLog = loadLog;

// ═══════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════
function showOnly(id) {
  ['lf', 'cf', 'vf', 'fp'].forEach((x) => $(x).classList.toggle('hidden', x !== id));
}
function showLogin() { $('lo').classList.remove('hidden'); showOnly('lf'); }
function hideLogin() { $('lo').classList.add('hidden'); }
function showLoginForm() { showOnly('lf'); $('le').textContent = ''; }
window.showLoginForm = showLoginForm;

async function doLogin() {
  const u = $('lu').value.trim();
  const p = $('lp').value;
  $('le').textContent = 'Signing in...';
  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: u, password: p }),
    });
    if (res.challenge === 'MFA_REQUIRED') {
      showOnly('vf');
      $('le').textContent = '';
      setTimeout(() => $('mc2').focus(), 80);
      return;
    }
    ME = res.user;
    if (res.mustChangePw) {
      showOnly('cf');
      $('le').textContent = '';
      // Pre-fill the current-password field with what the user just typed
      // so they don't need to retype it. (The original UI re-used the
      // login field in memory, which produced a stale value if anything
      // mutated it.)
      $('cpCur').value = p;
      setTimeout(() => $('np1').focus(), 50);
      return;
    }
    await onAuthed();
  } catch (err) {
    $('le').textContent = err.message || 'Login failed';
  }
}
window.doLogin = doLogin;

async function doForceChg() {
  const cur = $('cpCur').value;
  const np = $('np1').value, np2 = $('np2').value;
  if (!cur) { $('ce').textContent = 'Current password required'; return; }
  if (np !== np2) { $('ce').textContent = 'Passwords do not match'; return; }
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: cur, newPassword: np }),
    });
    // Server invalidated all sessions — log in again with the new password.
    $('ce').textContent = 'Password updated — signing you back in...';
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('lu').value.trim(), password: np }),
    });
    const me = await api('/api/auth/me');
    ME = me.user;
    // Wipe sensitive fields
    $('cpCur').value = '';
    $('np1').value = '';
    $('np2').value = '';
    $('lp').value = '';
    await onAuthed();
  } catch (err) {
    $('ce').textContent = err.message || 'Failed';
  }
}
window.doForceChg = doForceChg;

async function doMfaLoginVerify() {
  const code = $('mc2').value.trim();
  if (code.length !== 6) { $('me2').textContent = 'Enter a 6-digit code'; return; }
  $('me2').textContent = 'Verifying...';
  try {
    const res = await api('/api/auth/mfa-verify', {
      method: 'POST',
      body: JSON.stringify({ token: code }),
    });
    ME = res.user;
    if (res.mustChangePw) {
      showOnly('cf');
      $('cpCur').value = $('lp').value;
      return;
    }
    await onAuthed();
  } catch (err) {
    $('me2').textContent = err.message || 'Invalid code';
  }
}
window.doMfaLoginVerify = doMfaLoginVerify;

function showForgot() { showOnly('fp'); $('fpMsg').textContent = ''; }
window.showForgot = showForgot;

async function doForgot() {
  const email = $('fpEmail').value.trim();
  if (!email) { $('fpMsg').textContent = 'Enter your email'; return; }
  $('fpMsg').textContent = 'Sending...';
  try {
    const res = await api('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    $('fpMsg').style.color = 'var(--green)';
    $('fpMsg').textContent = res.message || 'If that email is registered, a reset link has been sent.';
  } catch (err) {
    $('fpMsg').textContent = err.message || 'Failed';
  }
}
window.doForgot = doForgot;

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  ME = null;
  $('gearDrop').classList.remove('on');
  $('gearBtn').setAttribute('aria-expanded', 'false');
  showLogin();
}
window.doLogout = doLogout;

async function onAuthed() {
  hideLogin();
  $('curUser').textContent = ME.username;
  usr = ME.username;
  const isAdmin = ME.role === 'admin';
  $('miAdmin').classList.toggle('on', isAdmin);
  const logBtn = $('bt-log');
  logBtn.classList.toggle('hidden', !isAdmin);
  logBtn.style.display = isAdmin ? '' : 'none';
  const invBtn = $('bt-inventory');
  if (invBtn) {
    invBtn.classList.toggle('hidden', !isAdmin);
    invBtn.style.display = isAdmin ? '' : 'none';
  }
  if (!isAdmin && ($('pg-log').classList.contains('on') || $('pg-inventory').classList.contains('on'))) {
    swPage('checkout');
  }
}

// ═══════════════════════════════════════════════════════════
// GEAR MENU
// ═══════════════════════════════════════════════════════════
function toggleGear() {
  const d = $('gearDrop');
  const open = !d.classList.contains('on');
  d.classList.toggle('on', open);
  $('gearBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
}
window.toggleGear = toggleGear;

document.addEventListener('click', (e) => {
  const gw = $('gearWrap');
  if (gw && !gw.contains(e.target)) {
    $('gearDrop').classList.remove('on');
    $('gearBtn').setAttribute('aria-expanded', 'false');
  }
});

// Allow Enter/Space to activate gear menu items (since they are divs)
document.addEventListener('keydown', (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('gear-item')) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.target.click();
    }
  }
  // Close any visible overlay on Escape
  if (e.key === 'Escape') {
    if (!$('eqEditOv').classList.contains('hidden')) { hideEqEdit(); return; }
    if (!$('chpOv').classList.contains('hidden')) { hideChp(); return; }
    if (!$('mfaOv').classList.contains('hidden')) { hideMfa(); return; }
    if (!$('adminOv').classList.contains('hidden')) { hideAdmin(); return; }
    if ($('gearDrop').classList.contains('on')) {
      $('gearDrop').classList.remove('on');
      $('gearBtn').setAttribute('aria-expanded', 'false');
      $('gearBtn').focus();
    }
  }
});

// ── Change password (signed-in user) ──
function showChp() {
  _lastFocusedBeforeOverlay = document.activeElement;
  $('gearDrop').classList.remove('on');
  $('gearBtn').setAttribute('aria-expanded', 'false');
  $('chpOv').classList.remove('hidden');
  setTimeout(() => $('cpOld').focus(), 30);
}
window.showChp = showChp;

function hideChp() {
  $('chpOv').classList.add('hidden');
  ['cpOld', 'cpN1', 'cpN2'].forEach((x) => ($(x).value = ''));
  $('cpErr').textContent = '';
  if (_lastFocusedBeforeOverlay && _lastFocusedBeforeOverlay.focus) {
    _lastFocusedBeforeOverlay.focus();
  }
}
window.hideChp = hideChp;

async function doChgPass() {
  const old = $('cpOld').value, np = $('cpN1').value, np2 = $('cpN2').value;
  if (np !== np2) { $('cpErr').textContent = 'Passwords do not match'; return; }
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: old, newPassword: np }),
    });
    hideChp();
    toast('Password changed — sign in again', 'green');
    ME = null;
    showLogin();
  } catch (err) {
    $('cpErr').textContent = err.message || 'Failed';
  }
}
window.doChgPass = doChgPass;

// ── MFA setup ──
async function showMfa() {
  _lastFocusedBeforeOverlay = document.activeElement;
  $('gearDrop').classList.remove('on');
  $('gearBtn').setAttribute('aria-expanded', 'false');
  $('mfaErr').textContent = 'Loading QR code...';
  $('mfaOv').classList.remove('hidden');
  try {
    const { qr, secret } = await api('/api/auth/mfa/setup', { method: 'POST' });
    $('mfaQr').src = qr;
    $('mfaQr').alt = 'MFA QR code — scan with authenticator app';
    $('mfaSecret').textContent = secret;
    $('mfaErr').textContent = '';
    setTimeout(() => $('mfaCode').focus(), 30);
  } catch (err) {
    $('mfaErr').textContent = err.message || 'Failed to start MFA setup';
  }
}
window.showMfa = showMfa;

function hideMfa() {
  $('mfaOv').classList.add('hidden');
  $('mfaCode').value = '';
  $('mfaErr').textContent = '';
  if (_lastFocusedBeforeOverlay && _lastFocusedBeforeOverlay.focus) {
    _lastFocusedBeforeOverlay.focus();
  }
}
window.hideMfa = hideMfa;

async function doMfaEnable() {
  const code = $('mfaCode').value.trim();
  if (code.length !== 6) { $('mfaErr').textContent = 'Enter a 6-digit code'; return; }
  try {
    await api('/api/auth/mfa/enable', {
      method: 'POST',
      body: JSON.stringify({ token: code }),
    });
    hideMfa();
    toast('MFA enabled', 'green');
  } catch (err) {
    $('mfaErr').textContent = err.message || 'Invalid code';
  }
}
window.doMfaEnable = doMfaEnable;

// ═══════════════════════════════════════════════════════════
// ADMIN PANEL
// ═══════════════════════════════════════════════════════════
function showAdmin() {
  _lastFocusedBeforeOverlay = document.activeElement;
  $('gearDrop').classList.remove('on');
  $('gearBtn').setAttribute('aria-expanded', 'false');
  $('adminOv').classList.remove('hidden');
  swAdmin('users');
}
window.showAdmin = showAdmin;

function hideAdmin() {
  $('adminOv').classList.add('hidden');
  if (_lastFocusedBeforeOverlay && _lastFocusedBeforeOverlay.focus) {
    _lastFocusedBeforeOverlay.focus();
  }
}
window.hideAdmin = hideAdmin;

function swAdmin(tab) {
  document.querySelectorAll('.admin-tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.admin-pane').forEach((p) =>
    p.classList.toggle('on', p.id === 'adm-' + tab));
  if (tab === 'users') loadAdminUsers();
  if (tab === 'overdue') loadOverdue();
  if (tab === 'audit') loadAudit();
}
window.swAdmin = swAdmin;

async function loadAdminUsers() {
  const ul = $('adminUL');
  ul.innerHTML = '<div class="sw"><div class="sp" aria-hidden="true"></div><span>Loading...</span></div>';
  const search = $('userSearch');
  if (search) search.value = '';
  try {
    const { users } = await api('/api/admin/users');
    cacheUsers = users || [];
    renderAdminUsers(cacheUsers);
  } catch (e) {
    ul.innerHTML = `<div class="es es-err"><div class="et">${esc(e.message)}</div></div>`;
  }
}

function renderAdminUsers(users) {
  const ul = $('adminUL');
  if (!users.length) {
    ul.innerHTML = '<div class="es"><div class="et">No matching users.</div></div>';
    return;
  }
  ul.innerHTML = '';
  users.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Open details for ${u.username}`);
    row.addEventListener('click', () => showUserDetail(u.id));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        showUserDetail(u.id);
      }
    });

    const main = document.createElement('div');
    main.className = 'user-main';
    const nm = document.createElement('div');
    nm.className = 'user-name';
    nm.textContent = u.username;
    const em = document.createElement('div');
    em.className = 'user-email';
    em.textContent = u.email || '';
    main.appendChild(nm);
    main.appendChild(em);

    const meta = document.createElement('div');
    meta.className = 'user-meta';
    if (u.role === 'admin') {
      const b = document.createElement('span');
      b.className = 'user-badge admin';
      b.textContent = 'ADMIN';
      meta.appendChild(b);
    }
    if (u.mfa_enabled) {
      const b = document.createElement('span');
      b.className = 'user-badge mfa';
      b.textContent = 'MFA';
      meta.appendChild(b);
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      const b = document.createElement('span');
      b.className = 'user-badge locked';
      b.textContent = 'LOCKED';
      meta.appendChild(b);
    }

    row.appendChild(main);
    row.appendChild(meta);
    ul.appendChild(row);
  });
}

function filterUsers() {
  const q = ($('userSearch').value || '').trim().toLowerCase();
  if (!q) {
    renderAdminUsers(cacheUsers);
    return;
  }
  const filtered = cacheUsers.filter((u) => {
    const name = (u.username || '').toLowerCase();
    const email = (u.email || '').toLowerCase();
    return name.includes(q) || email.includes(q);
  });
  renderAdminUsers(filtered);
}
window.filterUsers = filterUsers;

async function adminCreateUser() {
  const username = $('nuName').value.trim();
  const email = $('nuEmail').value.trim();
  const role = $('nuRole').value;
  if (!username || !email) {
    $('nuErr').textContent = 'Username and email required';
    return;
  }
  try {
    const res = await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username, email, role }),
    });
    $('nuName').value = '';
    $('nuEmail').value = '';
    $('nuErr').textContent = '';
    if (res.tempPassword) {
      $('nuTempPwVal').textContent = res.tempPassword;
      $('nuTempPw').classList.remove('hidden');
    }
    toast('User created — temp password shown below (also emailed)', 'green');
    loadAdminUsers();
  } catch (err) {
    $('nuErr').textContent = err.message || 'Failed';
  }
}
window.adminCreateUser = adminCreateUser;

async function showUserDetail(id) {
  const card = $('userDetail');
  card.classList.remove('hidden');
  $('udName').textContent = 'Loading...';
  $('udBody').innerHTML = '';
  try {
    const { user, currentCheckouts, history } = await api('/api/admin/users/' + id);
    $('udName').textContent = user.username + (user.role === 'admin' ? ' (admin)' : '');

    const body = $('udBody');
    body.innerHTML = '';

    const actions = document.createElement('div');
    actions.className = 'brow';

    const btnReset = document.createElement('button');
    btnReset.className = 'btn bw bsm';
    btnReset.type = 'button';
    btnReset.textContent = 'Reset PW';
    btnReset.addEventListener('click', () => adminResetPw(user.id, user.username));
    actions.appendChild(btnReset);

    const btnRole = document.createElement('button');
    btnRole.className = 'btn bo bsm';
    btnRole.type = 'button';
    btnRole.textContent = user.role === 'admin' ? 'Revoke Admin' : 'Make Admin';
    btnRole.addEventListener('click', () => adminToggleRole(user.id, user.role));
    actions.appendChild(btnRole);

    if (user.locked_until) {
      const btnUnlock = document.createElement('button');
      btnUnlock.className = 'btn bg bsm';
      btnUnlock.type = 'button';
      btnUnlock.textContent = 'Unlock';
      btnUnlock.addEventListener('click', () => adminUnlock(user.id));
      actions.appendChild(btnUnlock);
    }

    if (ME && user.id !== ME.id) {
      const btnDel = document.createElement('button');
      btnDel.className = 'btn br bsm';
      btnDel.type = 'button';
      btnDel.textContent = '🗑 Delete';
      btnDel.setAttribute('aria-label', `Delete user ${user.username}`);
      btnDel.addEventListener('click', () => {
        if (confirm('Permanently delete ' + user.username + '?')) adminDeleteUser(user.id);
      });
      actions.appendChild(btnDel);
    }
    body.appendChild(actions);

    const h1 = document.createElement('div');
    h1.className = 'ctitle';
    h1.textContent = 'Currently Checked Out';
    body.appendChild(h1);

    if (!currentCheckouts || !currentCheckouts.length) {
      const e = document.createElement('div');
      e.className = 'es';
      e.innerHTML = '<div class="et">No items</div>';
      body.appendChild(e);
    } else {
      currentCheckouts.forEach((e) => {
        const row = document.createElement('div');
        row.className = 'overdue-row';
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '8px';
        const days = e.checked_out_at
          ? Math.floor((Date.now() - new Date(e.checked_out_at).getTime()) / 86400000)
          : 0;
        if (days >= 5) row.classList.add('alert');
        else if (days >= 3) row.classList.add('warn');
        const info = document.createElement('div');
        info.style.flex = '1';
        const nm = document.createElement('div');
        nm.className = 'cname';
        nm.textContent = e.name;
        const meta = document.createElement('div');
        meta.className = 'overdue-days';
        meta.textContent = `${days} day${days === 1 ? '' : 's'} · ${new Date(e.checked_out_at).toLocaleDateString()}`;
        info.appendChild(nm);
        info.appendChild(meta);
        row.appendChild(info);
        const ciBtn = document.createElement('button');
        ciBtn.className = 'btn bg bsm';
        ciBtn.type = 'button';
        ciBtn.setAttribute('aria-label', `Check in ${e.name}`);
        ciBtn.textContent = '📥 In';
        ciBtn.addEventListener('click', async () => {
          try {
            await api(`/api/equipment/${e.id}/checkin`, {
              method: 'POST',
              body: JSON.stringify({ source: 'Manual' }),
            });
            toast(`"${e.name}" checked in`, 'green');
            showUserDetail(user.id);
          } catch (err) { toast(err.message, 'red'); }
        });
        row.appendChild(ciBtn);
        body.appendChild(row);
      });
    }

    const h2 = document.createElement('div');
    h2.className = 'ctitle';
    h2.style.marginTop = '1rem';
    h2.textContent = 'Recent Activity';
    body.appendChild(h2);

    if (!history || !history.length) {
      const e = document.createElement('div');
      e.className = 'es';
      e.innerHTML = '<div class="et">No activity</div>';
      body.appendChild(e);
    } else {
      history.slice(0, 20).forEach((h) => {
        const row = document.createElement('div');
        row.className = 'audit-row';
        const left = document.createElement('div');
        left.innerHTML = `<strong>${esc(h.action)}</strong> — ${esc(h.equipment_name || '')}`;
        const right = document.createElement('div');
        right.className = 'audit-when';
        right.textContent = new Date(h.created_at).toLocaleString();
        row.appendChild(left);
        row.appendChild(right);
        body.appendChild(row);
      });
    }
  } catch (err) {
    $('udBody').innerHTML = `<div class="es es-err"><div class="et">${esc(err.message)}</div></div>`;
  }
}
window.showUserDetail = showUserDetail;

function hideUserDetail() { $('userDetail').classList.add('hidden'); }
window.hideUserDetail = hideUserDetail;

async function adminResetPw(id, username) {
  if (!confirm('Reset password for ' + username + '? A new temp password will be generated and emailed.')) return;
  try {
    const res = await api('/api/admin/users/' + id, {
      method: 'PUT',
      body: JSON.stringify({ reset_password: true }),
    });
    const msg = res.tempPassword
      ? `Password reset for ${username}. Temp: ${res.tempPassword} (also emailed)`
      : `Password reset for ${username}`;
    toast(msg, 'green');
  } catch (err) {
    toast(err.message, 'red');
  }
}

async function adminToggleRole(id, currentRole) {
  const newRole = currentRole === 'admin' ? 'user' : 'admin';
  try {
    await api('/api/admin/users/' + id, {
      method: 'PUT',
      body: JSON.stringify({ role: newRole }),
    });
    toast('Role → ' + newRole, 'green');
    await loadAdminUsers();
    await showUserDetail(id);
  } catch (err) {
    toast(err.message, 'red');
  }
}

async function adminUnlock(id) {
  try {
    await api('/api/admin/users/' + id, {
      method: 'PUT',
      body: JSON.stringify({ unlock: true }),
    });
    toast('Unlocked', 'green');
    await showUserDetail(id);
  } catch (err) {
    toast(err.message, 'red');
  }
}

async function adminDeleteUser(id) {
  try {
    await api('/api/admin/users/' + id, { method: 'DELETE' });
    toast('User deleted', 'green');
    hideUserDetail();
    await loadAdminUsers();
  } catch (err) {
    toast(err.message, 'red');
  }
}

async function loadOverdue() {
  const el = $('overdueList');
  el.innerHTML = '<div class="sw"><div class="sp" aria-hidden="true"></div><span>Loading...</span></div>';
  try {
    const { items } = await api('/api/admin/overdue?days=1');
    if (!items.length) {
      el.innerHTML = '<div class="es"><div class="ei" aria-hidden="true">✅</div><div class="et">No overdue items!</div></div>';
      return;
    }
    el.innerHTML = '';
    items.forEach((i) => {
      const days = i.checked_out_at
        ? Math.floor((Date.now() - new Date(i.checked_out_at).getTime()) / 86400000)
        : 0;
      const row = document.createElement('div');
      row.className = 'overdue-row';
      if (days >= 5) row.classList.add('alert');
      else if (days >= 3) row.classList.add('warn');
      const name = document.createElement('div');
      name.className = 'cname';
      name.textContent = i.name;
      const meta = document.createElement('div');
      meta.className = 'overdue-days';
      meta.textContent = `${days} days · ${i.checked_out_username || ''} · ${new Date(i.checked_out_at).toLocaleDateString()}`;
      row.appendChild(name);
      row.appendChild(meta);
      el.appendChild(row);
    });
  } catch (err) {
    el.innerHTML = `<div class="es es-err"><div class="et">${esc(err.message)}</div></div>`;
  }
}

async function loadAudit() {
  const el = $('auditList');
  el.innerHTML = '<div class="sw"><div class="sp" aria-hidden="true"></div><span>Loading...</span></div>';
  try {
    const { entries } = await api('/api/admin/audit?limit=100');
    if (!entries.length) {
      el.innerHTML = '<div class="es"><div class="et">No audit entries.</div></div>';
      return;
    }
    el.innerHTML = '';
    const badgeMap = {
      login_success: ['LOGIN', 'bin'],
      login_failed: ['FAIL', 'bout'],
      logout: ['OUT', 'bwarn'],
      checkout: ['C/O', 'bout'],
      checkin: ['C/I', 'bin'],
      vision_scan: ['SCAN', 'bscan'],
      password_changed: ['PW', 'bwarn'],
      admin_create_user: ['NEW', 'bin'],
      admin_change_role: ['ROLE', 'bwarn'],
      admin_reset_password: ['RESET', 'bwarn'],
      admin_delete_user: ['DEL', 'bout'],
      admin_unlock_user: ['UNLOCK', 'bin'],
      equipment_create: ['ADD', 'bin'],
      equipment_update: ['EDIT', 'bwarn'],
      equipment_delete: ['DEL', 'bout'],
    };
    let html = '<div class="ls"><table><thead><tr><th scope="col">Action</th><th scope="col">User</th><th scope="col">Target</th><th scope="col">When</th></tr></thead><tbody>';
    entries.forEach((e) => {
      const [label, cls] = badgeMap[e.action] || [esc(e.action), 'bwarn'];
      const user = esc(e.username || '');
      const target = esc(e.target || '—');
      const when = esc(new Date(e.created_at).toLocaleString());
      html += `<tr>
        <td><span class="badge ${cls}">${label}</span></td>
        <td class="accent bold">${user}</td>
        <td class="mono small">${target}</td>
        <td class="mono small" style="color:var(--muted-strong)">${when}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    el.innerHTML = html;
  } catch (err) {
    el.innerHTML = `<div class="es es-err"><div class="et">${esc(err.message)}</div></div>`;
  }
}

// ═══════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════
(async function boot() {
  $('lp').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('mc2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doMfaLoginVerify(); });
  $('np2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doForceChg(); });
  $('cpN2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doChgPass(); });
  $('mfaCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') doMfaEnable(); });
  const eqBarcode = $('eqEditBarcode');
  if (eqBarcode) eqBarcode.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveEqEdit(); });

  // Click outside ov-card to dismiss (but only the equipment edit and MFA — keep
  // login/admin/forced-pw modal sticky to avoid accidental dismissal).
  $('eqEditOv').addEventListener('click', (e) => { if (e.target === $('eqEditOv')) hideEqEdit(); });

  try {
    const me = await api('/api/auth/me');
    if (me && me.user) {
      ME = me.user;
      await onAuthed();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
})();
