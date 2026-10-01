/* API dat nuoc theo nhom — The Curator Cafe
 * Luu tren Upstash Redis (REST). Moi nhom = 1 hash  g:<MA>
 *   field "meta"    -> {s:'open'|'sent', h:<mid truong nhom>, at, sentAt}
 *   field "m:<mid>" -> {n:<ten>, c:{<idMon>:<so luong>}, t:<cap nhat>, k:<hash token>}
 * Nhom tu xoa sau 6 gio khong hoat dong.
 */
const crypto = require('crypto');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK_ = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 6 * 3600;
const MAX_MEMBERS = 30;
const MAX_LINES = 40;
const MAX_QTY = 30;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function redis(...cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOK_, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const rnd = n => crypto.randomBytes(n).toString('hex');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
const newCode = () => Array.from(crypto.randomBytes(4), b => ALPHA[b % ALPHA.length]).join('');
const key = code => 'g:' + code;

function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
}
function cleanCode(s) {
  const c = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 4 ? c : '';
}
function cleanCart(c) {
  const out = {};
  if (!c || typeof c !== 'object') return out;
  Object.keys(c).slice(0, MAX_LINES).forEach(k => {
    const q = Math.floor(Number(c[k]));
    if (/^[a-z0-9~]{1,40}$/.test(k) && q > 0) out[k] = Math.min(q, MAX_QTY);
  });
  return out;
}

async function load(code) {
  const arr = await redis('HGETALL', key(code));
  if (!arr || !arr.length) return null;
  const g = { meta: null, members: {} };
  for (let i = 0; i < arr.length; i += 2) {
    const f = arr[i];
    let v; try { v = JSON.parse(arr[i + 1]); } catch (e) { continue; }
    if (f === 'meta') g.meta = v;
    else if (f.startsWith('m:')) g.members[f.slice(2)] = v;
  }
  return g.meta ? g : null;
}

function publicView(code, g) {
  const host = g.members[g.meta.h];
  return {
    code,
    status: g.meta.s,
    sentAt: g.meta.sentAt || null,
    host: { mid: g.meta.h, name: host ? host.n : '' },
    members: Object.keys(g.members)
      .map(mid => ({ mid, name: g.members[mid].n, cart: g.members[mid].c || {}, t: g.members[mid].t, j: g.members[mid].j || 0 }))
      .sort((a, b) => (a.mid === g.meta.h ? -1 : b.mid === g.meta.h ? 1 : a.j - b.j)),
  };
}

function auth(g, mid, tok) {
  const m = g.members[mid];
  return m && tok && m.k === sha(tok) ? m : null;
}

async function rateLimit(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
  const k = 'rl:' + sha(ip) + ':' + Math.floor(Date.now() / 60000);
  const n = await redis('INCR', k);
  if (n === 1) await redis('EXPIRE', k, 70);
  return n <= 90; // 90 lan / phut / IP
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, body) => res.status(code).json(body);
  if (!URL_ || !TOK_) return send(503, { ok: false, err: 'Tính năng đặt nhóm chưa được bật.' });

  try {
    if (!(await rateLimit(req))) return send(429, { ok: false, err: 'Thao tác quá nhanh, thử lại sau ít giây.' });

    if (req.method === 'GET') {
      const code = cleanCode(req.query.code);
      const g = code && (await load(code));
      if (!g) return send(404, { ok: false, err: 'Nhóm không tồn tại hoặc đã hết hạn.' });
      return send(200, { ok: true, group: publicView(code, g) });
    }
    if (req.method !== 'POST') return send(405, { ok: false });

    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const now = Date.now();

    if (b.a === 'create') {
      const name = cleanName(b.name);
      if (!name) return send(400, { ok: false, err: 'Vui lòng nhập tên.' });
      const mid = rnd(4), tok = rnd(16);
      for (let i = 0; i < 6; i++) {
        const code = newCode();
        const okSet = await redis('HSETNX', key(code), 'meta', JSON.stringify({ s: 'open', h: mid, at: now }));
        if (okSet === 1) {
          await redis('HSET', key(code), 'm:' + mid, JSON.stringify({ n: name, c: cleanCart(b.cart), t: now, j: now, k: sha(tok) }));
          await redis('EXPIRE', key(code), TTL);
          const g = await load(code);
          return send(200, { ok: true, code, mid, tok, group: publicView(code, g) });
        }
      }
      return send(500, { ok: false, err: 'Không tạo được nhóm, thử lại.' });
    }

    const code = cleanCode(b.code);
    const g = code && (await load(code));
    if (!g) return send(404, { ok: false, err: 'Nhóm không tồn tại hoặc đã hết hạn.' });

    if (b.a === 'join') {
      const name = cleanName(b.name);
      if (!name) return send(400, { ok: false, err: 'Vui lòng nhập tên.' });
      if (g.meta.s !== 'open') return send(409, { ok: false, err: 'Nhóm đã gửi đơn, không thể tham gia.' });
      if (Object.keys(g.members).length >= MAX_MEMBERS) return send(409, { ok: false, err: 'Nhóm đã đủ ' + MAX_MEMBERS + ' người.' });
      const mid = rnd(4), tok = rnd(16);
      await redis('HSET', key(code), 'm:' + mid, JSON.stringify({ n: name, c: cleanCart(b.cart), t: now, j: now, k: sha(tok) }));
      await redis('EXPIRE', key(code), TTL);
      g.members[mid] = { n: name, c: cleanCart(b.cart), t: now, j: now };
      return send(200, { ok: true, mid, tok, group: publicView(code, g) });
    }

    const me = auth(g, b.mid, b.tok);
    if (!me) return send(403, { ok: false, err: 'Bạn không còn trong nhóm này.', gone: true });
    const isHost = b.mid === g.meta.h;

    if (b.a === 'save') {
      if (g.meta.s !== 'open') return send(409, { ok: false, err: 'Nhóm đã gửi đơn.', group: publicView(code, g) });
      me.c = cleanCart(b.cart);
      if (b.name) me.n = cleanName(b.name) || me.n;
      me.t = now;
      await redis('HSET', key(code), 'm:' + b.mid, JSON.stringify(me));
      await redis('EXPIRE', key(code), TTL);
      return send(200, { ok: true, group: publicView(code, g) });
    }

    if (b.a === 'leave') {
      if (isHost) return send(400, { ok: false, err: 'Trưởng nhóm không thể rời nhóm.' });
      if (g.meta.s !== 'open') return send(409, { ok: false, err: 'Nhóm đã gửi đơn.' });
      await redis('HDEL', key(code), 'm:' + b.mid);
      return send(200, { ok: true });
    }

    if (b.a === 'remove') {
      if (!isHost) return send(403, { ok: false, err: 'Chỉ trưởng nhóm được xoá thành viên.' });
      if (b.target === b.mid || !g.members[b.target]) return send(400, { ok: false });
      if (g.meta.s !== 'open') return send(409, { ok: false, err: 'Nhóm đã gửi đơn.' });
      await redis('HDEL', key(code), 'm:' + b.target);
      delete g.members[b.target];
      return send(200, { ok: true, group: publicView(code, g) });
    }

    if (b.a === 'send') {
      if (!isHost) return send(403, { ok: false, err: 'Chỉ trưởng nhóm được gửi đơn.' });
      if (g.meta.s === 'open') {
        const any = Object.values(g.members).some(m => Object.keys(m.c || {}).length);
        if (!any) return send(400, { ok: false, err: 'Nhóm chưa có món nào.' });
        g.meta.s = 'sent'; g.meta.sentAt = now;
        await redis('HSET', key(code), 'meta', JSON.stringify(g.meta));
        await redis('EXPIRE', key(code), TTL);
      }
      return send(200, { ok: true, group: publicView(code, g) });
    }

    return send(400, { ok: false, err: 'Thao tác không hợp lệ.' });
  } catch (e) {
    console.error(e);
    return send(500, { ok: false, err: 'Lỗi máy chủ, thử lại sau.' });
  }
};
