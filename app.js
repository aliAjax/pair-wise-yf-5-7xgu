'use strict';

/* =========================================================
 * 社区共享厨房 · 保鲜柜预约
 * 纯本地应用：所有数据保存在浏览器 localStorage
 * ========================================================= */

// ---------- 常量 ----------
const SLOTS = [
  { id: 'morning', label: '上午时段', range: '08:00 – 12:00', start: 8, end: 12 },
  { id: 'noon',    label: '午间时段', range: '12:00 – 18:00', start: 12, end: 18 },
  { id: 'evening', label: '晚间时段', range: '18:00 – 22:00', start: 18, end: 22 },
];
const SLOT_BY_ID = Object.fromEntries(SLOTS.map(s => [s.id, s]));

const TYPES = {
  fridge:  { label: '冷藏', icon: '❄️' },
  freezer: { label: '冷冻', icon: '🧊' },
};

const STORE_KEY = 'freshcabinet.v1';
const SESSION_KEY = 'freshcabinet.admin';
const REDEEM_GRACE_MS = 2 * 60 * 60 * 1000;   // 时段结束后 2 小时内核销
const MAX_ACTIVE_PER_ROOM = 2;                 // 每户最多 2 个未来预约
const MAX_BOXES = 6;

const STATUS_LABEL = {
  reserved: '待核销',
  redeemed: '已核销',
  expired:  '已超时',
};

// ---------- 状态 ----------
let db = null;
let state = null;
let sweepTimer = null;

function defaultDB() {
  return {
    pin: '8888',
    capacities: { fridge: 12, freezer: 10 },
    seeded: false,
    reservations: [],   // 预约记录（含已核销 / 已超时，长期保留给管理员）
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      db = Object.assign(defaultDB(), parsed);
      db.capacities = Object.assign({ fridge: 12, freezer: 10 }, parsed.capacities || {});
    } else {
      db = defaultDB();
    }
  } catch (e) {
    console.error('读取本地数据失败', e);
    db = defaultDB();
  }
}

function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(db));
}

function defaultState() {
  return {
    tab: 'booking',
    room: '',
    name: '',
    date: dateKey(new Date()),
    slot: null,
    type: 'fridge',
    boxes: 1,
    adminAuth: sessionStorage.getItem(SESSION_KEY) === '1',
    filter: 'all',
  };
}

// ---------- 日期工具 ----------
function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function slotEndDate(r) {
  const d = parseKey(r.date);
  d.setHours(SLOT_BY_ID[r.slot].end, 0, 0, 0);
  return d;
}
function slotStartDate(r) {
  const d = parseKey(r.date);
  d.setHours(SLOT_BY_ID[r.slot].start, 0, 0, 0);
  return d;
}
function deadline(r) {
  return slotEndDate(r).getTime() + REDEEM_GRACE_MS;
}
function todayKey() { return dateKey(new Date()); }
function maxDateKey() {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return dateKey(d);
}
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
function dateLabel(key) {
  const d = parseKey(key);
  const t = todayKey();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tmKey = dateKey(tomorrow);
  let prefix = '';
  if (key === t) prefix = '今天 · ';
  else if (key === tmKey) prefix = '明天 · ';
  return `${prefix}${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAYS[d.getDay()]}`;
}
function fmtTime(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtFull(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
         `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function countdownText(r, now) {
  const start = slotStartDate(r).getTime();
  const end = slotEndDate(r).getTime();
  const dl = deadline(r);
  if (now < start) {
    const d = parseKey(r.date);
    return { text: `尚未开始，${d.getMonth() + 1}月${d.getDate()}日 ${SLOT_BY_ID[r.slot].start}:00 开始`, cls: 'cd-ok' };
  }
  if (now < end) {
    return { text: `时段进行中，${fmtTime(end)} 结束`, cls: 'cd-ok' };
  }
  const diff = dl - now;
  if (diff <= 0) return { text: '已超过核销时限', cls: 'cd-over' };
  const mins = Math.ceil(diff / 60000);
  if (mins <= 30) return { text: `距格子释放仅剩 ${mins} 分钟`, cls: 'cd-warn' };
  return { text: `取餐倒计时：${Math.floor(mins / 60)}小时${mins % 60 ? (mins % 60) + '分' : ''}`, cls: 'cd-ok' };
}

// ---------- 业务状态查询 ----------
function isActive(r, now) {
  return r.status === 'reserved' && deadline(r) > now;
}
function activeReservations(now) {
  now = now || Date.now();
  return db.reservations.filter(r => isActive(r, now));
}
function roomActiveCount(room, now) {
  const key = normalizeRoom(room);
  return activeReservations(now).filter(r => r.room === key).length;
}
function roomReservations(room, now) {
  const key = normalizeRoom(room);
  now = now || Date.now();
  return db.reservations
    .filter(r => r.room === key && isActive(r, now))
    .sort((a, b) => deadline(a) - deadline(b));
}
function normalizeRoom(v) {
  return String(v || '').trim().replace(/\s+/g, '');
}

// 当前日期/时段/柜层下，占格预约（已过期未核销的不再占格）
function occupancyAt(date, slotId, type, now) {
  now = now || Date.now();
  return db.reservations.filter(r =>
    r.date === date && r.slot === slotId && r.type === type && isActive(r, now)
  );
}
function occupiedIds(date, slotId, type, now) {
  const set = new Set();
  occupancyAt(date, slotId, type, now).forEach(r => r.cells.forEach(c => set.add(c)));
  return set;
}
function freeCount(date, slotId, type, now) {
  const occ = occupiedIds(date, slotId, type, now);
  return Math.max(0, db.capacities[type] - occ.size);
}
// 自动分配连续挑选后的空闲格子
function pickFreeIds(date, slotId, type, n, now) {
  const occ = occupiedIds(date, slotId, type, now);
  const result = [];
  for (let i = 1; i <= db.capacities[type] && result.length < n; i++) {
    const id = type === 'fridge' ? `冷${i}` : `冻${i}`;
    if (!occ.has(id)) result.push(id);
  }
  return result;
}

// ---------- 超时扫描：状态流转 ----------
function sweep(now) {
  now = now || Date.now();
  let changed = false;
  db.reservations.forEach(r => {
    if (r.status === 'reserved' && deadline(r) <= now) {
      r.status = 'expired';
      r.expiredAt = now;
      // 格子随之释放：其他住户在新的预约里即可选到这些格子（记录保留）
      changed = true;
    }
  });
  if (changed) save();
  return changed;
}

// ---------- 编号 / 取餐码 ----------
function genId() {
  return 'R' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}
function genCode(now) {
  now = now || Date.now();
  const used = new Set(
    db.reservations.filter(r => r.status === 'reserved' && deadline(r) > now).map(r => r.code)
  );
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (used.has(code));
  return code;
}

// ---------- 创建预约（不覆盖任何旧记录） ----------
function createBooking(input) {
  const now = Date.now();
  sweep(now);

  const room = normalizeRoom(input.room);
  const name = String(input.name || '').trim();
  const { date, slot, type, boxes } = input;

  if (!room) return { ok: false, msg: '请填写房号' };
  if (!name) return { ok: false, msg: '请填写住户姓名' };
  if (!date || !SLOT_BY_ID[slot]) return { ok: false, msg: '请选择日期和时段' };
  if (!TYPES[type]) return { ok: false, msg: '请选择冷藏或冷冻层' };
  if (!Number.isInteger(boxes) || boxes < 1 || boxes > MAX_BOXES) {
    return { ok: false, msg: `餐盒数量需为 1–${MAX_BOXES} 之间` };
  }
  // 不能预约已经开始（或已结束）的时段
  const start = slotStartDate({ date, slot }).getTime();
  if (start <= now) return { ok: false, msg: '该时段已开始，请选择其他时段' };
  // 每户最多两个未来预约
  if (roomActiveCount(room, now) >= MAX_ACTIVE_PER_ROOM) {
    return { ok: false, msg: `每户最多保留 ${MAX_ACTIVE_PER_ROOM} 个未来预约，请先取餐核销后再约` };
  }
  // 格子不足
  const cells = pickFreeIds(date, slot, type, boxes, now);
  if (cells.length < boxes) {
    return { ok: false, msg: `${TYPES[type].label}层空闲格子不足，当前仅剩 ${cells.length} 格` };
  }

  const r = {
    id: genId(),
    room,
    name,
    date,
    slot,
    type,
    boxes,
    cells,
    status: 'reserved',
    code: null,
    createdAt: now,
    createdBy: 'resident',
  };
  db.reservations.push(r);
  save();
  return { ok: true, reservation: r };
}

// ---------- 核销 ----------
function redeemByCode(code, now) {
  now = now || Date.now();
  sweep(now);
  code = String(code || '').trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, msg: '请输入完整的六位数字码' };

  const r = db.reservations.find(x => x.code === code);
  if (!r) return { ok: false, msg: '取餐码无效，请向管理员确认六位码' };
  if (r.status === 'redeemed') return { ok: false, msg: '该取餐码已核销过，格子已释放' };
  if (r.status === 'expired') return { ok: false, msg: '该预约已超时释放，请联系管理员处理' };
  if (deadline(r) <= now) return { ok: false, msg: '已超过 2 小时核销时限，格子已释放' };

  r.status = 'redeemed';
  r.redeemedAt = now;
  save();
  return { ok: true, reservation: r };
}

// 管理员生成/查看取餐码
function ensureCode(id) {
  const r = db.reservations.find(x => x.id === id);
  if (!r) return null;
  if (r.status === 'reserved' && !r.code) {
    r.code = genCode();
    save();
  }
  return r;
}

// ---------- 管理员操作 ----------
function deleteReservation(id) {
  const i = db.reservations.findIndex(r => r.id === id);
  if (i >= 0) {
    db.reservations.splice(i, 1);
    save();
    return true;
  }
  return false;
}
// =========================================================
//  UI
// =========================================================
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' t-' + kind : '');
  el.textContent = msg;
  $('#toastRoot').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 2200);
}

function modal({ title, bodyHTML, actions }) {
  const root = $('#modalRoot');
  root.innerHTML = '';
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3>
      <div class="modal-body">${bodyHTML}</div>
      <div class="modal-actions"></div>
    </div>`;
  const actBox = mask.querySelector('.modal-actions');
  (actions || [{ text: '知道了', kind: 'btn-primary' }]).forEach((a, i) => {
    const b = document.createElement('button');
    b.className = `btn ${a.kind || 'btn-ghost'}`;
    b.textContent = a.text;
    b.addEventListener('click', () => {
      if (a.onClick === false) return;
      closeModal();
      if (typeof a.onClick === 'function') a.onClick();
    });
    actBox.appendChild(b);
  });
  mask.addEventListener('click', e => { if (e.target === mask) closeModal(); });
  root.appendChild(mask);
}
function closeModal() { $('#modalRoot').innerHTML = ''; }

// =========================================================
//  渲染：预约页
// =========================================================
function defaultSlotForDate(dateKeyStr, now) {
  now = now || new Date();
  for (const s of SLOTS) {
    const start = new Date(parseKey(dateKeyStr));
    start.setHours(s.start, 0, 0, 0);
    if (start.getTime() > now.getTime()) return s.id;
  }
  return null;
}

function renderBooking(now) {
  // 日期输入范围
  const dInput = $('#bkDate');
  dInput.min = todayKey();
  dInput.max = maxDateKey();
  if (dInput.value !== state.date) dInput.value = state.date;
  // 日期失效则回到今天
  if (!dInput.value || dInput.value < todayKey() || dInput.value > maxDateKey()) {
    state.date = todayKey();
    dInput.value = state.date;
  }

  renderSlots(now);
  renderTypeSeg();
  renderStepper();
  renderCabinet(now);
  renderMyBookings(now);
}

function renderSlots(now) {
  // 已开始的时段不可选；自动修正所选时段
  const list = $('#slotList');
  const isToday = state.date === todayKey();
  let validSlot = state.slot;

  list.innerHTML = SLOTS.map(s => {
    const start = new Date(parseKey(state.date));
    start.setHours(s.start, 0, 0, 0);
    const disabled = isToday && start.getTime() <= now;
    if (disabled && validSlot === s.id) validSlot = null;
    const freeF = freeCount(state.date, s.id, 'fridge', now);
    const freeZ = freeCount(state.date, s.id, 'freezer', now);
    return `
      <button type="button" class="slot-btn ${state.slot === s.id ? 'active' : ''}"
              data-action="pickSlot" data-slot="${s.id}" ${disabled ? 'disabled' : ''}>
        <span>
          <span class="slot-name">${s.label} ${s.range}</span><br/>
          <span class="slot-meta">${disabled ? '该时段已开始，无法预约' : '结束后 2 小时内核销取餐'}</span>
        </span>
        <span class="free-tag">❄️${freeF} · 🧊${freeZ}</span>
      </button>`;
  }).join('');

  if (!validSlot) {
    const auto = isToday ? defaultSlotForDate(state.date, new Date(now)) : SLOTS[0].id;
    state.slot = auto;
    // 重新高亮
    $$('#slotList .slot-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.slot === state.slot);
    });
  } else {
    state.slot = validSlot;
  }
}

function renderTypeSeg() {
  $$('#typeSeg .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === state.type);
  });
}

function renderStepper() {
  $('#boxesVal').textContent = state.boxes;
}

function renderCabinet(now) {
  const cab = $('#cabinet');
  const hint = $('#cabinetHint');
  $('#submitBtn').disabled = false;

  if (!state.slot) {
    cab.innerHTML = '<div class="empty">今天所有时段均已开始，请选择明天及以后的日期</div>';
    hint.textContent = '';
    $('#availText').textContent = '';
    $('#submitBtn').disabled = true;
    return;
  }

  const occ = occupancyAt(state.date, state.slot, state.type, now);
  const occMap = new Map();
  occ.forEach(r => r.cells.forEach(c => occMap.set(c, r)));

  const cap = db.capacities[state.type];
  const free = freeCount(state.date, state.slot, state.type, now);
  const wanted = Math.min(state.boxes, free, MAX_BOXES);
  const preIds = new Set(pickFreeIds(state.date, state.slot, state.type, wanted, now));

  $('#availText').textContent = `空闲 ${free}/${cap} 格`;

  // 每行 4 格（移动端友好），最后一行不足 4 格时均分
  const perRow = 4;
  let html = `
    <div class="layer-title">
      <span>${TYPES[state.type].icon} ${TYPES[state.type].label}层 · 共 ${cap} 格</span>
      <span>点击橙色格子查看占用住户</span>
    </div>`;
  let cellsHtml = '';
  for (let i = 1; i <= cap; i++) {
    const id = state.type === 'fridge' ? `冷${i}` : `冻${i}`;
    const r = occMap.get(id);
    let cls = 'cell free', sub = '空闲', action = '';
    if (r) {
      cls = 'cell occupied';
      sub = esc(r.room);
      action = `data-action="showOcc" data-id="${r.id}"`;
    } else if (preIds.has(id)) {
      cls = 'cell pre';
      sub = '本次预选';
    }
    cellsHtml += `<div class="${cls}" ${action}>
                    <span class="cell-no">${esc(id)}</span>
                    <span class="cell-sub">${sub}</span>
                  </div>`;
    if (i % perRow === 0 || i === cap) {
      const cols = cap - (i - 1) >= perRow ? perRow : ((cap - 1) % perRow) + 1;
      html += `<div class="cell-row" style="grid-template-columns:repeat(${cols},1fr)">${cellsHtml}</div>`;
      cellsHtml = '';
    }
  }
  cab.innerHTML = html;

  if (free === 0) {
    hint.innerHTML = '⚠️ 该时段此柜层已约满，可切换柜层 / 时段 / 日期，或查看橙色格子联系住户';
  } else if (state.boxes > free) {
    hint.innerHTML = `⚠️ 空闲格子不足，本次最多可约 <b>${free}</b> 盒`;
  } else {
    hint.textContent = `绿色为本次预约将占用的 ${wanted} 个格子，提交后锁定。`;
  }
}

function renderMyBookings(now) {
  const room = normalizeRoom(state.room);
  const card = $('#myBookingsCard');
  if (!room) { card.hidden = true; return; }
  const list = roomReservations(room, now);
  card.hidden = false;
  $('#myCountPill').textContent = `${list.length}/${MAX_ACTIVE_PER_ROOM}`;
  const box = $('#myBookings');
  if (!list.length) {
    box.innerHTML = '<div class="empty">本户暂无未来有效预约</div>';
    return;
  }
  box.innerHTML = list.map(r => bookingItemHTML(r, now, false)).join('');
}

function bookingItemHTML(r, now, admin) {
  const cd = countdownText(r, now);
  const dl = fmtTime(deadline(r));
  return `
  <div class="${admin ? 'admin-item' : 'booking-item'}">
    <div class="bi-top">
      <div>
        <div class="bi-title">${esc(r.room)} · ${esc(r.name)}
          <span style="font-weight:500;color:var(--ink-2);font-size:13px">${TYPES[r.type].icon}${TYPES[r.type].label} × ${r.boxes}盒</span>
        </div>
        <div class="bi-desc">${dateLabel(r.date)} · ${SLOT_BY_ID[r.slot].label}（${SLOT_BY_ID[r.slot].range}）</div>
      </div>
      <span class="status-tag st-${r.status}">${STATUS_LABEL[r.status]}</span>
    </div>
    <div class="bi-cells">格子：${r.cells.map(c => `<span class="tag">${esc(c)}</span>`).join('')}</div>
    ${r.status === 'reserved' ? `<div class="countdown ${cd.cls}">${cd.text} · 最晚 ${dl} 前核销</div>` : ''}
    ${r.status === 'redeemed' ? `<div class="bi-desc">已于 ${fmtTime(r.redeemedAt)} 核销取餐</div>` : ''}
    ${r.status === 'expired' ? `<div class="bi-desc" style="color:var(--red)">已于 ${fmtTime(r.expiredAt)} 超时释放（记录留存）</div>` : ''}
    ${r.code && r.status === 'reserved' ? `<div class="code-badge">${r.code}</div>` : ''}
  </div>`;
}

// =========================================================
//  渲染：管理员页
// =========================================================
const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'reserved', label: '待核销' },
  { id: 'redeemed', label: '已核销' },
  { id: 'expired', label: '已超时' },
];

function renderAdmin(now) {
  if (!state.adminAuth) {
    $('#adminLoginCard').hidden = false;
    $('#adminPanel').hidden = true;
    return;
  }
  $('#adminLoginCard').hidden = true;
  $('#adminPanel').hidden = false;
  renderStats(now);
  renderFilters();
  renderAdminList(now);
  $('#setFridge').value = db.capacities.fridge;
  $('#setFreezer').value = db.capacities.freezer;
}

function renderStats(now) {
  const rs = db.reservations;
  const active = rs.filter(r => isActive(r, now));
  const expired = rs.filter(r => r.status === 'expired');
  const redeemed = rs.filter(r => r.status === 'redeemed');
  const rooms = new Set(active.map(r => r.room)).size;
  const stats = [
    { num: active.length, lbl: '当前占用预约', cls: 's-green' },
    { num: rooms, lbl: '涉及住户数', cls: 's-amber' },
    { num: expired.length, lbl: '超时释放记录', cls: 's-red' },
    { num: redeemed.length, lbl: '累计已核销', cls: 's-gray' },
  ];
  $('#statGrid').innerHTML = stats.map(s =>
    `<div class="stat ${s.cls}"><div class="num">${s.num}</div><div class="lbl">${s.lbl}</div></div>`
  ).join('');
}

function renderFilters() {
  $('#filterChips').innerHTML = FILTERS.map(f =>
    `<button type="button" class="chip ${state.filter === f.id ? 'active' : ''}" data-action="filter" data-filter="${f.id}">${f.label}</button>`
  ).join('');
}

function renderAdminList(now) {
  let list = db.reservations.slice();
  if (state.filter !== 'all') list = list.filter(r => r.status === state.filter);
  const statusRank = { reserved: 0, expired: 1, redeemed: 2 };
  list.sort((a, b) => {
    // 待核销最紧急，排在最前并按截止时间升序；其余按创建时间倒序
    if (a.status === 'reserved' && b.status === 'reserved') return deadline(a) - deadline(b);
    if (statusRank[a.status] !== statusRank[b.status]) return statusRank[a.status] - statusRank[b.status];
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  const box = $('#adminList');
  if (!list.length) {
    box.innerHTML = '<div class="empty">暂无相关记录</div>';
    return;
  }

  box.innerHTML = list.map(r => {
    let actions = '';
    if (r.status === 'reserved') {
      actions = `
        <div class="bi-actions">
          <button class="btn btn-primary btn-sm" data-action="genCode" data-id="${r.id}">
            ${r.code ? '查看取餐码' : '生成六位取餐码'}
          </button>
          <button class="btn btn-ghost btn-sm" data-action="adminRedeem" data-id="${r.id}">代客核销</button>
          <button class="btn btn-danger-ghost btn-sm" data-action="delRec" data-id="${r.id}">删除记录</button>
        </div>`;
    } else {
      actions = `
        <div class="bi-actions">
          <button class="btn btn-danger-ghost btn-sm" data-action="delRec" data-id="${r.id}">删除记录</button>
        </div>`;
    }
    const wrap = document.createElement('div');
    wrap.innerHTML = bookingItemHTML(r, now, true) + actions;
    return wrap.innerHTML;
  }).join('');
}

// =========================================================
//  Tab 切换 & 事件
// =========================================================
function switchTab(tab) {
  state.tab = tab;
  $$('.page').forEach(p => p.hidden = true);
  $('#page-' + tab).hidden = false;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.nav === tab));
  renderAll();
}

function renderAll() {
  const now = Date.now();
  sweep(now);
  if (state.tab === 'booking') renderBooking(now);
  if (state.tab === 'pickup') { /* 静态，结果保留 */ }
  if (state.tab === 'admin') renderAdmin(now);
}

// 全局事件委托
document.addEventListener('click', onAction);
function onAction(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const act = btn.dataset.action;

  switch (act) {
    // ---- 预约表单 ----
    case 'pickSlot':
      state.slot = btn.dataset.slot;
      renderAll();
      break;
    case 'boxesInc':
      state.boxes = Math.min(MAX_BOXES, state.boxes + 1);
      renderAll();
      break;
    case 'boxesDec':
      state.boxes = Math.max(1, state.boxes - 1);
      renderAll();
      break;
    case 'submitBooking':
      submitBooking();
      break;
    case 'showOcc':
      showOccupancy(btn.dataset.id);
      break;

    // ---- 取餐 ----
    case 'pickupRedeem':
      doPickup();
      break;

    // ---- 管理员 ----
    case 'adminLogin': adminLogin(); break;
    case 'adminLogout': adminLogout(); break;
    case 'filter':
      state.filter = btn.dataset.filter;
      renderAll();
      break;
    case 'genCode': showCode(btn.dataset.id); break;
    case 'adminRedeem': adminRedeem(btn.dataset.id); break;
    case 'delRec': confirmDelete(btn.dataset.id); break;
    case 'saveCaps': saveCapacities(); break;
    case 'changePin': changePin(); break;
    case 'exportData': exportData(); break;
    case 'importData': $('#importFile').click(); break;
    case 'clearData': confirmClear(); break;
    case 'seedData': seedData(); break;
  }
}

document.addEventListener('change', e => {
  if (e.target.id === 'bkDate') {
    state.date = e.target.value || todayKey();
    state.slot = null; // 日期变化后重新挑一个有效时段
    renderAll();
  }
});

// 柜层分段按钮
$('#typeSeg').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn');
  if (!b) return;
  state.type = b.dataset.type;
  renderAll();
});

// 房号/姓名输入（轻量刷新我的预约，不全量重绘以免打断输入）
$('#bkRoom').addEventListener('input', e => {
  state.room = e.target.value;
  renderMyBookings(Date.now());
});
$('#bkName').addEventListener('input', e => { state.name = e.target.value; });

// 取餐码只留数字
$('#pickCode').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});
$('#adminPin').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});
$('#oldPin').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
$('#newPin').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });

// 底部导航
$$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.nav)));

// ---------- 预约动作 ----------
function submitBooking() {
  const res = createBooking({
    room: state.room,
    name: state.name,
    date: state.date,
    slot: state.slot,
    type: state.type,
    boxes: state.boxes,
  });
  if (!res.ok) {
    toast(res.msg, 'err');
    renderAll();
    return;
  }
  const r = res.reservation;
  modal({
    title: '✅ 预约成功',
    bodyHTML: `
      <div class="kv"><span>住户</span><b>${esc(r.room)} · ${esc(r.name)}</b></div>
      <div class="kv"><span>时间</span><b>${dateLabel(r.date)} ${SLOT_BY_ID[r.slot].label}</b></div>
      <div class="kv"><span>柜层</span><b>${TYPES[r.type].icon}${TYPES[r.type].label} × ${r.boxes}盒</b></div>
      <div class="kv"><span>格子</span><b>${r.cells.map(esc).join('、')}</b></div>
      <p style="margin:10px 0 0;font-size:13px;color:var(--amber)">
        请在 ${fmtTime(deadline(r))} 前取餐，向管理员索要六位码完成核销；超时格子将自动释放。
      </p>`,
    actions: [
      { text: '知道了', kind: 'btn-primary' },
    ],
  });
  state.boxes = 1;
  renderAll();
}

function showOccupancy(id) {
  const r = db.reservations.find(x => x.id === id);
  if (!r || r.status !== 'reserved') {
    toast('该格子已释放', 'err');
    renderAll();
    return;
  }
  const cd = countdownText(r, Date.now());
  modal({
    title: '🔒 格子已被占用',
    bodyHTML: `
      <div class="kv"><span>占用住户</span><b>${esc(r.room)} · ${esc(r.name)}</b></div>
      <div class="kv"><span>预约时间</span><b>${dateLabel(r.date)} ${SLOT_BY_ID[r.slot].label}</b></div>
      <div class="kv"><span>柜层格子</span><b>${TYPES[r.type].icon}${TYPES[r.type].label} ${r.cells.map(esc).join('、')}</b></div>
      <div class="kv"><span>结束时间</span><b>${fmtTime(slotEndDate(r).getTime())}</b></div>
      <div class="kv"><span>最晚核销</span><b>${fmtTime(deadline(r))}</b></div>
      <p style="margin:10px 0 0;font-size:13px" class="${cd.cls}">${cd.text}；新预约不会覆盖此记录。</p>`,
    actions: [{ text: '我知道了', kind: 'btn-primary' }],
  });
}

// ---------- 取餐动作 ----------
function doPickup() {
  const code = $('#pickCode').value;
  const res = redeemByCode(code);
  const box = $('#pickResult');
  if (!res.ok) {
    box.innerHTML = `<div class="pick-err">❌ ${esc(res.msg)}</div>`;
    return;
  }
  const r = res.reservation;
  box.innerHTML = `
    <div class="pick-ok">
      ✅ <b>核销成功，感谢使用！</b><br/>
      ${esc(r.room)} · ${esc(r.name)} 的 ${r.boxes} 盒（${r.cells.map(esc).join('、')}）已取餐，格子已释放。
    </div>`;
  $('#pickCode').value = '';
  toast('核销成功，格子已释放', 'ok');
  renderAll();
}

// ---------- 管理员动作 ----------
function adminLogin() {
  const pin = $('#adminPin').value;
  if (pin !== db.pin) {
    toast('管理码错误', 'err');
    return;
  }
  state.adminAuth = true;
  sessionStorage.setItem(SESSION_KEY, '1');
  $('#adminPin').value = '';
  toast('欢迎，管理员', 'ok');
  renderAll();
}
function adminLogout() {
  state.adminAuth = false;
  sessionStorage.removeItem(SESSION_KEY);
  renderAll();
}

function showCode(id) {
  const r = ensureCode(id);
  if (!r) return;
  modal({
    title: '🔑 取餐六位码',
    bodyHTML: `
      <p style="margin:0 0 6px">住户：<b>${esc(r.room)} · ${esc(r.name)}</b></p>
      <p style="margin:0 0 6px">${dateLabel(r.date)} ${SLOT_BY_ID[r.slot].label} · ${TYPES[r.type].label} × ${r.boxes}盒</p>
      <div class="code-badge" style="font-size:26px;letter-spacing:8px">${r.code}</div>
      <p style="margin:10px 0 0;font-size:13px;color:var(--ink-2)">
        将此码告知住户，在「取餐」页输入即可核销。最晚核销时间 ${fmtTime(deadline(r))}。
      </p>`,
    actions: [{ text: '关闭', kind: 'btn-primary' }],
  });
  renderAll();
}

function adminRedeem(id) {
  const r = db.reservations.find(x => x.id === id);
  if (!r) return;
  sweep();
  if (r.status !== 'reserved') { toast('该记录不可核销（可能已超时释放）', 'err'); renderAll(); return; }
  modal({
    title: '确认代客核销？',
    bodyHTML: `<p>确认 <b>${esc(r.room)} · ${esc(r.name)}</b> 已取走 ${r.cells.map(esc).join('、')} 的 ${r.boxes} 盒餐食？核销后格子立即释放。</p>`,
    actions: [
      { text: '取消', kind: 'btn-ghost', onClick: false },
      {
        text: '确认核销', kind: 'btn-primary',
        onClick: () => {
          r.status = 'redeemed';
          r.redeemedAt = Date.now();
          save();
          toast('已核销，格子释放', 'ok');
          renderAll();
        },
      },
    ],
  });
}

function confirmDelete(id) {
  const r = db.reservations.find(x => x.id === id);
  if (!r) return;
  modal({
    title: '删除这条记录？',
    bodyHTML: `<p>将永久删除 <b>${esc(r.room)} · ${esc(r.name)}</b> 在 ${dateLabel(r.date)} ${SLOT_BY_ID[r.slot].label} 的${STATUS_LABEL[r.status]}记录。${r.status === 'reserved' ? '删除后对应格子立即释放。' : ''}</p>`,
    actions: [
      { text: '取消', kind: 'btn-ghost', onClick: false },
      {
        text: '确认删除', kind: 'btn-danger',
        onClick: () => {
          deleteReservation(id);
          toast('记录已删除', 'ok');
          renderAll();
        },
      },
    ],
  });
}

function saveCapacities() {
  const f = parseInt($('#setFridge').value, 10);
  const z = parseInt($('#setFreezer').value, 10);
  if (!Number.isInteger(f) || f < 1 || !Number.isInteger(z) || z < 1) {
    toast('格数需为大于 0 的整数', 'err');
    return;
  }
  // 检查现有预约是否超出新容量
  const now = Date.now();
  const overflow = activeReservations(now).some(r =>
    r.cells.some(c => {
      const n = parseInt(c.replace(/[^\d]/g, ''), 10);
      return (r.type === 'fridge' ? f : z) < n;
    })
  );
  const apply = () => {
    db.capacities = { fridge: f, freezer: z };
    save();
    toast('容量已保存', 'ok');
    renderAll();
  };
  if (overflow) {
    modal({
      title: '容量将小于在约格子',
      bodyHTML: '<p>存在进行中的预约使用了超出新容量的格位号，缩小容量不影响这些已有记录，但新预约按新格数分配。确定保存？</p>',
      actions: [
        { text: '取消', kind: 'btn-ghost', onClick: false },
        { text: '仍然保存', kind: 'btn-primary', onClick: apply },
      ],
    });
  } else apply();
}

function changePin() {
  const oldP = $('#oldPin').value;
  const newP = $('#newPin').value;
  if (oldP !== db.pin) { toast('原管理码错误', 'err'); return; }
  if (!/^\d{6}$/.test(newP)) { toast('新管理码必须为六位数字', 'err'); return; }
  db.pin = newP;
  save();
  $('#oldPin').value = '';
  $('#newPin').value = '';
  toast('管理码已修改', 'ok');
}

// ---------- 数据导入导出 ----------
function exportData() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `保鲜柜数据_${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
$('#importFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.reservations)) throw new Error('格式不符');
      modal({
        title: '确认导入并覆盖当前数据？',
        bodyHTML: `<p>文件含 <b>${data.reservations.length}</b> 条记录。导入将覆盖本机现有全部数据，建议先导出备份。</p>`,
        actions: [
          { text: '取消', kind: 'btn-ghost', onClick: false },
          {
            text: '确认导入', kind: 'btn-primary',
            onClick: () => {
              db = Object.assign(defaultDB(), data);
              db.capacities = Object.assign({ fridge: 12, freezer: 10 }, data.capacities || {});
              save();
              toast('数据已导入', 'ok');
              renderAll();
            },
          },
        ],
      });
    } catch (err) {
      toast('文件格式不正确', 'err');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
});

function confirmClear() {
  modal({
    title: '⚠️ 清空全部数据？',
    bodyHTML: '<p>所有预约记录、取餐码与设置将被删除，管理码恢复为 8888，此操作不可恢复。</p>',
    actions: [
      { text: '取消', kind: 'btn-ghost', onClick: false },
      {
        text: '确认清空', kind: 'btn-danger',
        onClick: () => {
          db = defaultDB();
          save();
          toast('已清空全部数据', 'ok');
          renderAll();
        },
      },
    ],
  });
}

// ---------- 演示数据 ----------
function seedData() {
  const now = Date.now();
  // 找一个尚未开始的时段放演示预约
  let date = todayKey();
  let slotId = defaultSlotForDate(date, new Date(now));
  if (!slotId) {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    date = dateKey(t);
    slotId = 'morning';
  }
  const demo = [
    { room: '3-201', name: '王阿姨', type: 'fridge',  boxes: 2, cellStart: 1 },
    { room: '5-103', name: '李师傅', type: 'freezer', boxes: 1, cellStart: 1 },
  ];
  demo.forEach(d => {
    const cells = [];
    for (let i = d.cellStart; i < d.cellStart + d.boxes; i++) {
      cells.push(d.type === 'fridge' ? `冷${i}` : `冻${i}`);
    }
    db.reservations.push({
      id: genId(), room: d.room, name: d.name, date, slot: slotId,
      type: d.type, boxes: d.boxes, cells,
      status: 'reserved', code: d.type === 'fridge' ? '246810' : null,
      createdAt: now - 3600_000, createdBy: 'resident',
    });
  });
  db.seeded = true;
  save();
  modal({
    title: '演示数据已生成',
    bodyHTML: `<p>已在 <b>${dateLabel(date)} ${SLOT_BY_ID[slotId].label}</b> 生成两条预约：</p>
      <p>• 3-201 王阿姨：冷藏 冷1、冷2，取餐码 <b>246810</b><br/>
      • 5-103 李师傅：冷冻 冻1（待管理员生成取餐码）</p>
      <p style="font-size:13px;color:var(--ink-2)">可到「取餐」页输入 246810 体验核销。</p>`,
    actions: [{ text: '去预约页看看', kind: 'btn-primary' }],
  });
  renderAll();
}

// =========================================================
//  启动
// =========================================================
function init() {
  load();
  state = defaultState();

  // 表单初始值
  $('#bkRoom').value = state.room;
  $('#bkName').value = state.name;
  $('#bkDate').value = state.date;
  state.slot = defaultSlotForDate(state.date, new Date());

  switchTab('booking');

  // 每 30 秒扫描超时并刷新倒计时/格子状态
  sweepTimer = setInterval(renderAll, 30000);
  // 页面重新可见时立即刷新（跨标签页数据变化）
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      load();
      renderAll();
    }
  });
  // 监听同浏览器其他标签页的存储变更
  window.addEventListener('storage', e => {
    if (e.key === STORE_KEY) { load(); renderAll(); }
  });
}

init();
