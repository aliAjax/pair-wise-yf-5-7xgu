// 社区共享厨房保鲜柜预约系统
// 零依赖 Node.js 服务：本地 JSON 持久化 + 手机端页面
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123'; // 管理员口令，部署时用环境变量覆盖

const LAYERS = ['冷藏', '冷冻'];
const SLOTS = [
  { id: 'morning', label: '早餐时段 07:00-10:00', end: '10:00' },
  { id: 'noon', label: '午餐时段 11:00-14:00', end: '14:00' },
  { id: 'evening', label: '晚餐时段 17:00-20:00', end: '20:00' },
];
const MAX_FUTURE_PER_HOUSEHOLD = 2;
const GRACE_HOURS = 2; // 时段结束后 2 小时未核销即释放

// ---------- 数据层 ----------
let db = { reservations: [] };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!Array.isArray(db.reservations)) db.reservations = [];
} catch { /* 首次启动 */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DATA_FILE); // 原子写，防止半截文件
  }, 50);
}

// ---------- 业务规则 ----------
function slotEnd(date, slotId) {
  const slot = SLOTS.find(s => s.id === slotId);
  return new Date(`${date}T${slot.end}:00`);
}

// 超时释放：active 且超过 时段结束+2h 未核销 → released，记录保留给管理员
function sweepExpired(now = new Date()) {
  let changed = false;
  for (const r of db.reservations) {
    if (r.status === 'active' && now.getTime() > slotEnd(r.date, r.slot).getTime() + GRACE_HOURS * 3600e3) {
      r.status = 'released';
      r.releasedAt = now.toISOString();
      changed = true;
    }
  }
  if (changed) save();
}

// 格子是否被占：同日期+时段+层 存在未释放、未核销的记录
function occupantOf(date, slot, layer) {
  return db.reservations.find(r =>
    r.date === date && r.slot === slot && r.layer === layer && r.status === 'active');
}

function futureCount(household, now = new Date()) {
  return db.reservations.filter(r =>
    r.household === household && r.status === 'active' &&
    slotEnd(r.date, r.slot).getTime() > now.getTime()
  ).length;
}

function publicView(r) {
  return {
    id: r.id, household: r.household, date: r.date, slot: r.slot, layer: r.layer,
    boxCount: r.boxCount, status: r.status, code: r.code,
    endTime: `${r.date} ${SLOTS.find(s => s.id === r.slot).end}`,
    createdAt: r.createdAt, redeemedAt: r.redeemedAt || null, releasedAt: r.releasedAt || null,
  };
}

// ---------- 路由 ----------
const routes = {
  // 预约面板：未来 7 天格子占用情况 + 指定住户的预约
  'GET /api/state': (q) => {
    sweepExpired();
    const household = q.get('household') || '';
    const days = [];
    const now = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getTime() + i * 86400e3);
      const date = d.toISOString().slice(0, 10);
      days.push({
        date,
        slots: SLOTS.map(s => ({
          ...s,
          layers: LAYERS.map(layer => {
            const occ = occupantOf(date, s.id, layer);
            return {
              layer,
              occupied: !!occ,
              occupiedBy: occ ? occ.household : null,
              occupiedEnd: occ ? `${occ.date} ${s.end}` : null,
            };
          }),
        })),
      });
    }
    return {
      days,
      mine: db.reservations.filter(r => r.household === household).map(publicView)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      maxFuture: MAX_FUTURE_PER_HOUSEHOLD,
      futureUsed: household ? futureCount(household) : 0,
    };
  },

  // 新建预约：不覆盖旧记录，冲突返回 409 + 占用信息
  'POST /api/reservations': (q, body) => {
    sweepExpired();
    const { household, date, slot, layer, boxCount } = body;
    if (!household || !date || !slot || !layer) throw httpError(400, '请填写住户、日期、时段和层');
    if (!SLOTS.some(s => s.id === slot)) throw httpError(400, '时段无效');
    if (!LAYERS.includes(layer)) throw httpError(400, '层无效');
    const n = parseInt(boxCount, 10);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw httpError(400, '餐盒数量须为 1-20');
    if (slotEnd(date, slot).getTime() <= Date.now()) throw httpError(400, '该时段已结束，无法预约');

    const occ = occupantOf(date, slot, layer);
    if (occ) {
      throw httpError(409, `该格子已被 ${occ.household} 占用，至 ${occ.date} ${SLOTS.find(s => s.id === slot).end} 结束`, {
        occupiedBy: occ.household,
        occupiedEnd: `${occ.date} ${SLOTS.find(s => s.id === slot).end}`,
      });
    }
    if (futureCount(household) >= MAX_FUTURE_PER_HOUSEHOLD) {
      throw httpError(429, `每户最多保留 ${MAX_FUTURE_PER_HOUSEHOLD} 个未来预约，请先核销或等旧预约结束`);
    }

    const r = {
      id: crypto.randomUUID(),
      household, date, slot, layer, boxCount: n,
      code: String(crypto.randomInt(0, 1000000)).padStart(6, '0'), // 六位核销码
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    db.reservations.push(r);
    save();
    return publicView(r);
  },

  // 取餐核销：管理员输入住户出示的六位码
  'POST /api/redeem': (q, body) => {
    sweepExpired();
    if (body.adminKey !== ADMIN_KEY) throw httpError(403, '管理员口令错误');
    const r = db.reservations.find(x => x.code === String(body.code || '').trim());
    if (!r) throw httpError(404, '核销码不存在');
    if (r.status === 'redeemed') throw httpError(409, `该码已于 ${r.redeemedAt} 核销过`);
    if (r.status === 'released') throw httpError(410, `该预约已超时释放（${r.releasedAt}），格子已回收`);
    r.status = 'redeemed';
    r.redeemedAt = new Date().toISOString();
    save();
    return publicView(r);
  },

  // 住户主动取消自己的未来预约
  'POST /api/cancel': (q, body) => {
    sweepExpired();
    const r = db.reservations.find(x => x.id === body.id && x.household === body.household);
    if (!r) throw httpError(404, '预约不存在或不属于该住户');
    if (r.status !== 'active') throw httpError(409, '该预约已核销或已释放，无法取消');
    r.status = 'cancelled';
    r.cancelledAt = new Date().toISOString();
    save();
    return publicView(r);
  },

  // 管理员总表：全部记录（含超时释放的），可按期筛选
  'GET /api/admin/records': (q) => {
    sweepExpired();
    if (q.get('adminKey') !== ADMIN_KEY) throw httpError(403, '管理员口令错误');
    const status = q.get('status');
    let list = db.reservations.map(publicView);
    if (status) list = list.filter(r => r.status === status);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
};

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, extra });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const key = `${req.method} ${u.pathname}`;

  if (routes[key]) {
    const done = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const handle = (body) => {
      try { done(200, routes[key](u.searchParams, body)); }
      catch (e) { done(e.status || 500, { error: e.message, ...(e.extra || {}) }); }
    };
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 1e5) req.destroy(); });
      req.on('end', () => { try { handle(JSON.parse(raw || '{}')); } catch { done(400, { error: '请求格式错误' }); } });
    } else handle({});
    return;
  }

  // 静态文件
  const file = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : u.pathname);
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('Not Found'); return;
  }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  res.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'text/plain') + '; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});

// 后台每分钟兜底扫一次超时（请求时也会扫）
setInterval(() => sweepExpired(), 60e3);

server.listen(PORT, () => console.log(`保鲜柜预约系统已启动: http://localhost:${PORT}  (管理员口令: ${ADMIN_KEY})`));
