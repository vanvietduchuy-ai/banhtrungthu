/* API "Sóc của bạn" — game nuôi sóc cho khách, The Curator Cafe
 * Lưu trên Upstash Redis (cùng database với đặt nhóm / theo dõi đơn).
 *   pet:<hash SĐT> -> JSON sóc (không lưu số điện thoại thật)
 *     nm    tên sóc            beans  hạt cà phê đang có     cups  tổng số ly đã nhận
 *     full  độ no lúc cho ăn   fedAt  thời điểm cho ăn        born  ngày nhận sóc
 *     pend  [{c,cnt,at}] đơn chờ cộng hạt   toks [hash token máy được sửa]
 * Hạt chỉ được cộng khi quầy chuyển đơn sang "Hoàn thành" (api/don),
 * hoặc tự cộng sau 24 giờ nếu đơn không bị huỷ. Đơn huỷ thì không cộng.
 */
const crypto = require('crypto');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK_ = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const BEANS_PER_CUP = 10, FEED_COST = 10, FEED_GAIN = 25, HUNGRY_HOURS = 96; // no 100% -> đói hẳn sau 4 ngày
const AUTO_CREDIT_MS = 24 * 3600e3;
const LEVELS = [
  { at: 0, n: 'Sóc con' }, { at: 5, n: 'Sóc nhỏ' }, { at: 15, n: 'Sóc barista' },
  { at: 35, n: 'Sóc trưởng quán' }, { at: 70, n: 'Sóc huyền thoại' },
];

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
const normPhone = p => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('84')) d = '0' + d.slice(2); return /^0\d{9,10}$/.test(d) ? d : ''; };
const petKey = ph => 'pet:' + sha('tc-pet:' + ph);
const cleanName = s => String(s || '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);

function levelOf(cups) {
  let i = 0; while (i < LEVELS.length - 1 && cups >= LEVELS[i + 1].at) i++;
  const cur = LEVELS[i], nxt = LEVELS[i + 1] || null;
  return { i, n: cur.n, at: cur.at, next: nxt ? nxt.at : null, nextN: nxt ? nxt.n : null };
}
function fullness(p, now) {
  const h = (now - (p.fedAt || p.born || now)) / 3600e3;
  return Math.max(0, Math.round((p.full == null ? 60 : p.full) - h / HUNGRY_HOURS * 100));
}
function view(p, now, canEdit) {
  const f = fullness(p, now);
  return {
    exists: true, nm: p.nm || '', beans: p.beans || 0, cups: p.cups || 0, lv: levelOf(p.cups || 0),
    full: f, mood: f >= 60 ? 'vui' : f >= 25 ? 'doi' : 'buon',
    pendCups: (p.pend || []).reduce((a, x) => a + (x.cnt || 0), 0),
    born: p.born, canEdit: !!canEdit, cost: FEED_COST,
  };
}
// cộng hạt cho các đơn đã hoàn thành
async function settle(p, now) {
  const pend = p.pend || [];
  if (!pend.length) return false;
  const raw = await redis('MGET', ...pend.map(x => 'o:' + x.c));
  const keep = []; let changed = false;
  pend.forEach((x, i) => {
    let o = null; try { o = raw[i] ? JSON.parse(raw[i]) : null; } catch (e) { o = null; }
    const st = o ? o.s : null;
    if (st === 'cancel') { changed = true; return; }
    if (st === 'done' || (st && now - x.at > AUTO_CREDIT_MS)) {
      p.beans = (p.beans || 0) + x.cnt * BEANS_PER_CUP; p.cups = (p.cups || 0) + x.cnt; p.got = (p.got || []).concat([x.c]).slice(-60); changed = true; return;
    }
    if (!o && now - x.at > 3 * 86400e3) { changed = true; return; } // đơn đã hết hạn theo dõi
    keep.push(x);
  });
  p.pend = keep;
  return changed;
}
async function rateLimit(req, limit) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
  const k = 'rls:' + sha(ip) + ':' + Math.floor(Date.now() / 60000);
  const n = await redis('INCR', k);
  if (n === 1) await redis('EXPIRE', k, 70);
  return n <= limit;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, body) => res.status(code).json(body);
  if (!URL_ || !TOK_) return send(503, { ok: false, err: 'Chưa bật nuôi sóc.' });
  try {
    if (!(await rateLimit(req, 60))) return send(429, { ok: false, err: 'Thao tác quá nhanh.' });
    const now = Date.now();
    const b = req.method === 'POST' ? (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})) : req.query;
    const ph = normPhone(b.ph);
    if (!ph) return send(400, { ok: false, err: 'Số điện thoại chưa đúng.' });
    const key = petKey(ph);
    // nhận nuôi muộn: gắn các đơn vừa đặt trên máy này (có khoá đơn k) vào sóc
    if (req.method === 'POST' && b.a === 'claim') {
      const list = (Array.isArray(b.os) ? b.os : []).slice(0, 10);
      let tok = null, n = 0;
      for (const x of list) {
        const c = String(x && x.c || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 30);
        if (!c || !x.k) continue;
        const raw0 = await redis('GET', 'o:' + c); if (!raw0) continue;
        const o = JSON.parse(raw0); if (o.k !== sha(x.k) || o.s === 'cancel') continue;
        const t = await module.exports.linkOrder(ph, c, o.cnt); if (t) { tok = t; n++; }
      }
      if (!tok) return send(400, { ok: false, err: 'Chưa có đơn nào trên máy này để nhận nuôi — đặt một ly là có sóc ngay.' });
      const p2 = JSON.parse(await redis('GET', key));
      return send(200, { ok: true, t: tok, n, pet: view(p2, now, true) });
    }
    const raw = await redis('GET', key);
    if (!raw) return send(200, { ok: true, pet: { exists: false } });
    const p = JSON.parse(raw);
    const canEdit = !!(b.t && (p.toks || []).includes(sha(b.t)));
    let changed = await settle(p, now);

    if (req.method === 'POST') {
      if (!canEdit) return send(403, { ok: false, err: 'Máy này chưa đặt đơn bằng số này nên chưa chăm sóc được.' });
      if (b.a === 'name') {
        const nm = cleanName(b.nm);
        if (!nm) return send(400, { ok: false, err: 'Tên chưa hợp lệ.' });
        p.nm = nm; changed = true;
      } else if (b.a === 'feed') {
        if ((p.beans || 0) < FEED_COST) { if (changed) await redis('SET', key, JSON.stringify(p)); return send(400, { ok: false, err: 'Chưa đủ hạt — đặt thêm nước để có hạt nhé.', pet: view(p, now, canEdit) }); }
        const f = fullness(p, now);
        if (f >= 100) return send(400, { ok: false, err: 'Sóc no căng rồi!', pet: view(p, now, canEdit) });
        p.beans -= FEED_COST; p.full = Math.min(100, f + FEED_GAIN); p.fedAt = now; changed = true;
      } else return send(400, { ok: false, err: 'Thao tác không hợp lệ.' });
    }
    if (changed) await redis('SET', key, JSON.stringify(p));
    return send(200, { ok: true, pet: view(p, now, canEdit) });
  } catch (e) {
    console.error(e);
    return send(500, { ok: false, err: 'Lỗi máy chủ.' });
  }
};

// dùng chung cho api/don: gắn đơn vào sóc của khách, trả token cho máy vừa đặt
module.exports.linkOrder = async function (phone, code, cnt) {
  const ph = normPhone(phone);
  if (!ph || !code || !(cnt > 0)) return null;
  const key = petKey(ph), now = Date.now();
  // mỗi đơn chỉ nuôi được một sóc, một lần
  const claimed = await redis('SET', 'pc:' + code, key, 'NX', 'EX', 5 * 86400);
  if (claimed !== 'OK' && (await redis('GET', 'pc:' + code)) !== key) return null;
  const raw = await redis('GET', key);
  const p = raw ? JSON.parse(raw) : { nm: '', beans: 0, cups: 0, full: 70, fedAt: now, born: now, pend: [], toks: [] };
  p.got = p.got || [];
  if (!p.got.includes(code) && !(p.pend || []).some(x => x.c === code)) p.pend = (p.pend || []).concat([{ c: code, cnt: Math.min(99, cnt), at: now }]).slice(-30);
  const tok = crypto.randomBytes(12).toString('hex');
  p.toks = (p.toks || []).concat([sha(tok)]).slice(-6);
  await redis('SET', key, JSON.stringify(p));
  return tok;
};
