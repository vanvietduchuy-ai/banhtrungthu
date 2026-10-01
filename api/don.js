/* API trang thai don hang — The Curator Cafe
 * Luu tren Upstash Redis (cung database voi dat nhom).
 *   o:<MA DON>  -> JSON don (TTL 3 ngay)
 *   ol          -> sorted set: MA DON theo thoi gian (cho trang quay)
 * Khach xem don bang token rieng (k) hoac ma nhom (g) voi don nhom.
 * Quay cap nhat trang thai bang ma PIN: bien moi truong STAFF_PIN.
 */
const crypto = require('crypto');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK_ = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PIN = process.env.STAFF_PIN || '';
const TTL = 3 * 86400;
const STATUSES = ['new', 'ok', 'make', 'ready', 'ship', 'done', 'cancel'];

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
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
const txt = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const cleanCode = s => { const c = String(s || '').toUpperCase().replace(/[^A-Z0-9-]/g, ''); return /^(CF|NHOM-)[A-Z0-9-]{4,24}$/.test(c) ? c : ''; };
const pinOk = p => PIN && typeof p === 'string' && p.length >= 4 && crypto.timingSafeEqual(Buffer.from(sha(p)), Buffer.from(sha(PIN)));

function cleanItems(a) {
  if (!Array.isArray(a)) return [];
  return a.slice(0, 120).map(i => ({
    w: txt(i && i.w, 30),
    n: txt(i && i.n, 60),
    q: Math.max(1, Math.min(99, Math.floor(Number(i && i.q) || 1))),
    p: Math.max(0, Math.min(5e6, Math.floor(Number(i && i.p) || 0))),
    t: txt(i && i.t, 160),
  })).filter(i => i.n);
}
function view(o) {
  return { c: o.c, kind: o.kind, at: o.at, s: o.s, h: o.h, why: o.why || '', items: o.items, tot: o.tot, cnt: o.cnt,
    ship: o.ship, time: o.time, nm: o.nm, g: o.g || null };
}
async function rateLimit(req, limit) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
  const k = 'rld:' + sha(ip) + ':' + Math.floor(Date.now() / 60000);
  const n = await redis('INCR', k);
  if (n === 1) await redis('EXPIRE', k, 70);
  return n <= limit;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, body) => res.status(code).json(body);
  if (!URL_ || !TOK_) return send(503, { ok: false, err: 'Chưa bật theo dõi đơn.' });
  try {
    const staffPin = req.headers['x-staff-pin'];
    if (!(await rateLimit(req, staffPin ? 400 : 120))) return send(429, { ok: false, err: 'Thao tác quá nhanh.' });

    if (req.method === 'GET') {
      // trang quay: danh sach trang thai trong 48 gio
      if (req.query.staff) {
        if (!PIN) return send(503, { ok: false, err: 'Chưa đặt STAFF_PIN trên Vercel.' });
        if (!pinOk(staffPin)) return send(403, { ok: false, err: 'Sai mã PIN.' });
        const since = Date.now() - 48 * 3600e3;
        const codes = (await redis('ZRANGEBYSCORE', 'ol', since, '+inf')) || [];
        if (!codes.length) return send(200, { ok: true, list: [] });
        const raw = await redis('MGET', ...codes.map(c => 'o:' + c));
        const list = raw.map(x => { try { const o = JSON.parse(x); return { c: o.c, s: o.s, t: o.h[o.h.length - 1].t }; } catch (e) { return null; } }).filter(Boolean);
        return send(200, { ok: true, list });
      }
      // khach: xem mot hoac nhieu don
      const want = String(req.query.c || '').split(',').slice(0, 12).map(cleanCode).filter(Boolean);
      const keys = String(req.query.k || '').split(',');
      const grp = String(req.query.g || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!want.length) return send(400, { ok: false });
      const raw = await redis('MGET', ...want.map(c => 'o:' + c));
      const out = {};
      raw.forEach((x, i) => {
        if (!x) return;
        let o; try { o = JSON.parse(x); } catch (e) { return; }
        const kk = keys[i] || keys[0] || '';
        if ((kk && o.k === sha(kk)) || (grp && o.gk && o.gk === grp)) out[o.c] = view(o);
      });
      return send(200, { ok: true, orders: out });
    }
    if (req.method !== 'POST') return send(405, { ok: false });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const now = Date.now();

    if (b.a === 'create') {
      const c = cleanCode(b.c);
      if (!c) return send(400, { ok: false, err: 'Mã đơn không hợp lệ.' });
      const items = cleanItems(b.items);
      if (!items.length) return send(400, { ok: false, err: 'Đơn trống.' });
      const tok = crypto.randomBytes(12).toString('hex');
      const grp = String(b.g && b.g.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      const o = {
        c, kind: b.kind === 'nhom' ? 'nhom' : 'le', at: now, s: 'new', h: [{ s: 'new', t: now }],
        items, tot: items.reduce((a, i) => a + i.p * i.q, 0), cnt: items.reduce((a, i) => a + i.q, 0),
        ship: txt(b.ship, 30), time: txt(b.time, 10), nm: txt(b.nm, 40),
        g: grp ? { code: grp, name: txt(b.g.name, 40) } : null, gk: grp || '', k: sha(tok),
      };
      const okSet = await redis('SET', 'o:' + c, JSON.stringify(o), 'EX', TTL, 'NX');
      if (okSet !== 'OK') return send(409, { ok: false, err: 'Mã đơn đã tồn tại.' });
      await redis('ZADD', 'ol', now, c);
      await redis('ZREMRANGEBYSCORE', 'ol', 0, now - TTL * 1000);
      return send(200, { ok: true, c, k: tok, order: view(o) });
    }

    if (b.a === 'status') {
      if (!PIN) return send(503, { ok: false, err: 'Chưa đặt STAFF_PIN trên Vercel.' });
      if (!pinOk(staffPin || b.pin)) return send(403, { ok: false, err: 'Sai mã PIN.' });
      const c = cleanCode(b.c), s = String(b.s || '');
      if (!c || !STATUSES.includes(s)) return send(400, { ok: false, err: 'Thiếu thông tin.' });
      const x = await redis('GET', 'o:' + c);
      if (!x) return send(404, { ok: false, err: 'Không tìm thấy đơn trên hệ thống theo dõi.' });
      const o = JSON.parse(x);
      if (o.s !== s) { o.s = s; o.h.push({ s, t: now }); if (o.h.length > 20) o.h = o.h.slice(-20); }
      o.why = s === 'cancel' ? txt(b.why, 120) : '';
      await redis('SET', 'o:' + c, JSON.stringify(o), 'KEEPTTL');
      return send(200, { ok: true, order: view(o) });
    }
    return send(400, { ok: false, err: 'Thao tác không hợp lệ.' });
  } catch (e) {
    console.error(e);
    return send(500, { ok: false, err: 'Lỗi máy chủ.' });
  }
};
