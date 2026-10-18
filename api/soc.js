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
// cửa hàng đồ cho sóc: giá tính bằng hạt cà phê, mỗi ô (slot) mặc 1 món
const SHOP = {
  nonla: { s: 'hat', p: 40 }, beanie: { s: 'hat', p: 30 }, santa: { s: 'hat', p: 50 }, cap: { s: 'hat', p: 30, soon: 1 },
  flower: { s: 'hat', p: 40, soon: 1 }, party: { s: 'hat', p: 25, soon: 1 },
  glasses: { s: 'eye', p: 35, soon: 1 }, hearts: { s: 'eye', p: 45, soon: 1 },
  scarf: { s: 'neck', p: 30 }, bow: { s: 'neck', p: 20, soon: 1 }, bell: { s: 'neck', p: 35, soon: 1 },
  overall: { s: 'body', p: 60, soon: 1 },
};
// món "soon": chưa có ảnh sóc mặc thật nên chưa bán. Sóc mặc 1 món nổi bật một lúc (ảnh vẽ sẵn sóc đang mặc món đó).
const PIN = process.env.STAFF_PIN || '';
const pinOk = p => PIN && typeof p === 'string' && p.length >= 4 && crypto.timingSafeEqual(Buffer.from(sha(p)), Buffer.from(sha(PIN)));
const SLOTS = ['hat', 'eye', 'neck', 'body'];
// số demo để trình diễn: ai cũng chăm được, hạt không bao giờ hết, đổi cấp tuỳ ý
const DEMO = '0123456789';
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
async function pipe(cmds) { // nhiều lệnh một lượt (Upstash pipeline)
  if (!cmds.length) return [];
  const r = await fetch(URL_.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + TOK_, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  const j = await r.json();
  return (Array.isArray(j) ? j : []).map(x => x && x.result);
}
// ---- thống kê cho trang quản trị: đếm theo ngày (giờ Việt Nam), giữ 400 ngày ----
const vnDay = (t = Date.now()) => new Date(t + 7 * 3600e3).toISOString().slice(0, 10);
const vnMonth = (t = Date.now()) => vnDay(t).slice(0, 7);
async function stat(fields, extra) {
  const d = 'pst:' + vnDay(), cmds = [];
  for (const f in fields) { cmds.push(['HINCRBY', d, f, fields[f]]); cmds.push(['HINCRBY', 'pst:all', f, fields[f]]); }
  cmds.push(['EXPIRE', d, 400 * 86400]);
  if (extra) cmds.push(...extra);
  try { await pipe(cmds); } catch (e) { console.error(e); }
}
const EVENTS = ['open', 'optin', 'optout', 'tickle', 'pet', 'board', 'share', 'friend'];
// lan toả: giới thiệu bạn (cả hai +REF_BONUS hạt khi bạn được giao ly đầu tiên), tổ sóc (đạt mốc ly trong tháng -> mỗi thành viên +GRP_BONUS), quà ghé thăm mỗi ngày
const REF_BONUS = 20, GRP_BONUS = 15, GRP_MAX = 10, GRP_STEPS = [20, 50, 100, 200], DAILY_GIFT = 2;
const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
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
    inv: p.inv || [], eq: p.eq || {}, demo: !!p.demo,
    id: p._id || '', grp: p.grp || '', daily: p.dailyAt === vnDay(now), refN: p.refN || 0, house: !!p.house,
    grpGift: p.grpGift && now - p.grpGift.at < 3 * 86400e3 ? p.grpGift : null,
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
      p.beans = (p.beans || 0) + x.cnt * BEANS_PER_CUP; p.cups = (p.cups || 0) + x.cnt; p.got = (p.got || []).concat([x.c]).slice(-60); changed = true;
      p._cr = (p._cr || 0) + x.cnt; return;
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
    // sự kiện ẩn danh từ giao diện (mở cửa sổ, nhận nuôi, từ chối, cù, vuốt…)
    if (req.method === 'POST' && b.a === 'ev') {
      if (EVENTS.includes(b.e)) await stat({ ['ev_' + b.e]: 1 });
      return send(200, { ok: true });
    }
    // bảng xếp hạng: tháng này hoặc mọi thời — chỉ tên sóc, cấp, số ly; không lộ số điện thoại
    if (b.a === 'top') {
      if (b.per === 'grp') return send(200, { ok: true, ...(await groupBoard()) });
      return send(200, { ok: true, ...(await board(b.per === 'all' ? 'all' : 'month', normPhone(b.ph))) });
    }
    // thẻ sóc công khai (khi khách chia sẻ link): chỉ tên, cấp, số ly, món đang mặc, hạng
    if (b.a === 'card') {
      const id = String(b.id || '').replace(/[^a-f0-9]/g, '').slice(0, 32), k = 'pet:' + id, r0 = id && await redis('GET', k);
      if (!r0) return send(404, { ok: false, err: 'Không tìm thấy sóc.' });
      const q = JSON.parse(r0); if (q.demo) return send(404, { ok: false, err: 'Không tìm thấy sóc.' });
      const rk = await redis('ZREVRANK', 'pets', k), eq = q.eq || {};
      let gn = ''; if (q.grp) { const gr = await redis('GET', 'grp:' + q.grp); if (gr) gn = JSON.parse(gr).nm || ''; }
      return send(200, { ok: true, card: { n: q.hide || !q.nm ? petTag(k) : q.nm, lv: levelOf(q.cups || 0).i, cups: q.cups || 0, wear: Object.values(eq)[0] || '', rank: rk == null ? null : rk + 1, grp: gn, house: !!q.house } });
    }
    if (b.a === 'group') {
      const code = cleanCode(b.code), gr = code && await redis('GET', 'grp:' + code);
      if (!gr || gr === '{}') return send(404, { ok: false, err: 'Không tìm thấy tổ sóc này.' });
      return send(200, { ok: true, group: await groupView(code, JSON.parse(gr), normPhone(b.ph)) });
    }
    // quản trị: cần mã PIN quầy
    if (b.a === 'admin' || b.a === 'hide' || b.a === 'house') {
      // vào bằng tài khoản admin (cùng trang quản trị menu) hoặc mã PIN quầy
      let tokOk = false; try { tokOk = require('./menu').tokenOk(req); } catch (e) {}
      if (!tokOk && !pinOk(req.headers['x-staff-pin'])) return send(403, { ok: false, err: 'Sai mật khẩu / mã PIN.' });
      // sóc nhà quán: sóc thật của nhân viên (đặt nước bằng số của mình), luôn gắn nhãn "Nhà Curator" trên bảng xếp hạng
      if (b.a === 'house') {
        let k;
        if (b.ph) { const hp = normPhone(b.ph); if (!hp || hp === DEMO) return send(400, { ok: false, err: 'Số điện thoại chưa đúng.' }); k = petKey(hp); }
        else k = 'pet:' + String(b.k || '').replace(/[^a-f0-9]/g, '').slice(0, 32);
        const r0 = await redis('GET', k), now0 = Date.now();
        const q = r0 ? JSON.parse(r0) : { nm: '', beans: 0, cups: 0, full: 70, fedAt: now0, born: now0, pend: [], toks: [] };
        if (b.off) delete q.house; else { q.house = true; const nm = cleanName(b.nm); if (nm) q.nm = nm; }
        await redis('SET', k, JSON.stringify(q)); await redis('ZADD', 'pets', q.cups || 0, k);
        return send(200, { ok: true, house: !!q.house });
      }
      if (b.a === 'hide') {
        const k = 'pet:' + String(b.k || '').replace(/[^a-f0-9]/g, '').slice(0, 32); const r0 = await redis('GET', k);
        if (!r0) return send(404, { ok: false, err: 'Không thấy sóc.' });
        const q = JSON.parse(r0); q.hide = !q.hide; await redis('SET', k, JSON.stringify(q));
        return send(200, { ok: true, hide: q.hide });
      }
      return send(200, { ok: true, ...(await admin(Math.max(7, Math.min(90, Number(b.days) || 30)))) });
    }
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
        const t = await module.exports.linkOrder(ph, c, o.cnt, b.ref); if (t) { tok = t; n++; }
      }
      if (!tok) return send(400, { ok: false, err: 'Chưa có đơn nào trên máy này để nhận nuôi — đặt một ly là có sóc ngay.' });
      const p2 = JSON.parse(await redis('GET', key));
      return send(200, { ok: true, t: tok, n, pet: view(p2, now, true) });
    }
    // số demo chỉ chủ quán mở được (cần mã PIN quầy); khách nhập số này chỉ thấy như số chưa có sóc
    const demoOk = ph === DEMO && pinOk(req.headers['x-staff-pin']);
    if (ph === DEMO && !demoOk) return req.method === 'POST' ? send(403, { ok: false, err: 'Số này chưa có sóc.' }) : send(200, { ok: true, pet: { exists: false } });
    let raw = await redis('GET', key);
    if (!raw && demoOk) {
      raw = JSON.stringify({ nm: 'Hạt Dẻ', beans: 999, cups: 40, full: 70, fedAt: now, born: now - 30 * 86400e3, pend: [], toks: [], inv: [], eq: {}, demo: true });
      await redis('SET', key, raw);
    }
    if (!raw) return send(200, { ok: true, pet: { exists: false } });
    const p = JSON.parse(raw); p._id = key.slice(4);
    const canEdit = p.demo || !!(b.t && (p.toks || []).includes(sha(b.t)));
    if (p.demo && (p.beans || 0) < 200) p.beans = 999;
    let changed = await settle(p, now);

    if (req.method === 'POST') {
      if (!canEdit) return send(403, { ok: false, err: 'Máy này chưa đặt đơn bằng số này nên chưa chăm sóc được.' });
      if (b.a === 'name' && p.demo) return send(400, { ok: false, err: 'Sóc demo giữ tên Hạt Dẻ nhé.' });
      if (b.a === 'name') {
        const nm = cleanName(b.nm);
        if (!nm) return send(400, { ok: false, err: 'Tên chưa hợp lệ.' });
        p.nm = nm; changed = true;
      } else if (b.a === 'feed') {
        if ((p.beans || 0) < FEED_COST) { if (changed) { delete p._cr; await redis('SET', key, JSON.stringify(p)); } return send(400, { ok: false, err: 'Chưa đủ hạt — đặt thêm nước để có hạt nhé.', pet: view(p, now, canEdit) }); }
        const f = fullness(p, now);
        if (f >= 100) return send(400, { ok: false, err: 'Sóc no căng rồi!', pet: view(p, now, canEdit) });
        p.beans -= FEED_COST; p.full = Math.min(100, f + FEED_GAIN); p.fedAt = now; changed = true;
      } else if (b.a === 'buy') {
        const it = SHOP[b.id];
        if (!it || it.soon) return send(400, { ok: false, err: 'Món này sắp có.' });
        p.inv = p.inv || []; p.eq = p.eq || {};
        if (!p.inv.includes(b.id)) {
          if ((p.beans || 0) < it.p) return send(400, { ok: false, err: 'Chưa đủ hạt — cần ' + it.p + ' hạt.', pet: view(p, now, canEdit) });
          p.beans -= it.p; p.inv.push(b.id); p._bought = it.p;
        }
        p.eq = { [it.s]: b.id }; changed = true;
      } else if (b.a === 'wear') {
        p.eq = p.eq || {};
        if (!SLOTS.includes(b.s)) return send(400, { ok: false, err: 'Thao tác không hợp lệ.' });
        if (b.id) { const it = SHOP[b.id]; if (!it || it.soon || it.s !== b.s || !(p.inv || []).includes(b.id)) return send(400, { ok: false, err: 'Bạn chưa có món này.' }); p.eq = { [b.s]: b.id }; }
        else delete p.eq[b.s];
        changed = true;
      } else if (b.a === 'daily') {
        if (p.dailyAt === vnDay(now)) return send(200, { ok: true, gift: 0, pet: view(p, now, canEdit) });
        p.dailyAt = vnDay(now); p.beans = (p.beans || 0) + DAILY_GIFT; changed = true; p._gift = DAILY_GIFT;
      } else if (b.a === 'gcreate' || b.a === 'gjoin') {
        if (p.demo) return send(400, { ok: false, err: 'Sóc demo không vào tổ.' });
        if (p.grp) return send(400, { ok: false, err: 'Sóc đã ở trong một tổ — rời tổ cũ trước nhé.' });
        let code, g;
        if (b.a === 'gcreate') {
          const nm = cleanName(b.nm); if (!nm) return send(400, { ok: false, err: 'Đặt tên cho tổ sóc nhé.' });
          for (let i = 0; i < 6 && !code; i++) { const c = crypto.randomBytes(4).toString('hex').toUpperCase().replace(/[01]/g, 'K').slice(0, 5); if ((await redis('SET', 'grp:' + c, '{}', 'NX')) === 'OK') code = c; }
          if (!code) return send(500, { ok: false, err: 'Thử lại nhé.' });
          g = { nm, owner: key, mem: [], at: now, paid: {} };
        } else {
          code = cleanCode(b.code); const gr = code && await redis('GET', 'grp:' + code);
          if (!gr || gr === '{}') return send(404, { ok: false, err: 'Không tìm thấy tổ sóc này.' });
          g = JSON.parse(gr); if ((g.mem || []).length >= GRP_MAX) return send(400, { ok: false, err: 'Tổ đã đủ ' + GRP_MAX + ' sóc.' });
        }
        g.mem = (g.mem || []).filter(k => k !== key).concat([key]);
        await redis('SET', 'grp:' + code, JSON.stringify(g)); p.grp = code; changed = true; p._gev = b.a;
      } else if (b.a === 'gleave') {
        if (p.grp) { const gr = await redis('GET', 'grp:' + p.grp); if (gr) { const g = JSON.parse(gr); g.mem = (g.mem || []).filter(k => k !== key);
          if (g.mem.length) { if (g.owner === key) g.owner = g.mem[0]; await redis('SET', 'grp:' + p.grp, JSON.stringify(g)); } else await redis('DEL', 'grp:' + p.grp); } }
        delete p.grp; changed = true;
      } else if (b.a === 'lv' && p.demo) {
        const i = Math.max(0, Math.min(LEVELS.length - 1, Math.floor(Number(b.i) || 0)));
        p.cups = LEVELS[i].at + (i ? 2 : 1); changed = true;
      } else return send(400, { ok: false, err: 'Thao tác không hợp lệ.' });
    }
    const st = {}, ex = [];
    if (p._cr && !p.demo) await afterCredit(p, key, now, st);
    if (p._gift) st.daily = 1; const gift = p._gift || 0; delete p._gift;
    if (p._gev) { st[p._gev] = 1; delete p._gev; }
    if (p._cr) { st.credit = p._cr; if (!p.demo) ex.push(['ZINCRBY', 'petm:' + vnMonth(now), p._cr, key], ['EXPIRE', 'petm:' + vnMonth(now), 120 * 86400]); delete p._cr; }
    if (req.method === 'POST') { if (b.a === 'feed') { st.feed = 1; st.spent = FEED_COST; } if (b.a === 'buy' && p._bought) { st.buy = 1; st['buy_' + b.id] = 1; st.spent = (st.spent || 0) + p._bought; } if (b.a === 'name') st.named = 1; }
    delete p._bought; const pid = p._id; delete p._id;
    if (changed) await redis('SET', key, JSON.stringify(p)); p._id = pid;
    if (!p.demo) { ex.push(['ZADD', 'pets', p.cups || 0, key], ['PFADD', 'pact:' + vnDay(now), key], ['EXPIRE', 'pact:' + vnDay(now), 400 * 86400]); await stat(st, ex); }
    return send(200, { ok: true, gift, pet: view(p, now, canEdit) });
  } catch (e) {
    console.error(e);
    return send(500, { ok: false, err: 'Lỗi máy chủ.' });
  }
};

// dùng chung cho api/don: gắn đơn vào sóc của khách, trả token cho máy vừa đặt
module.exports.linkOrder = async function (phone, code, cnt, ref) {
  const ph = normPhone(phone);
  if (!ph || ph === DEMO || !code || !(cnt > 0)) return null;
  const key = petKey(ph), now = Date.now();
  // mỗi đơn chỉ nuôi được một sóc, một lần
  const claimed = await redis('SET', 'pc:' + code, key, 'NX', 'EX', 5 * 86400);
  if (claimed !== 'OK' && (await redis('GET', 'pc:' + code)) !== key) return null;
  const raw = await redis('GET', key);
  const p = raw ? JSON.parse(raw) : { nm: '', beans: 0, cups: 0, full: 70, fedAt: now, born: now, pend: [], toks: [] };
  p.got = p.got || [];
  const st = {};
  if (!raw) { st.adopt = 1; const rf = String(ref || '').replace(/[^a-f0-9]/g, '').slice(0, 32); if (rf && 'pet:' + rf !== key && await redis('EXISTS', 'pet:' + rf)) { p.ref = rf; st.refLink = 1; } }
  if (!p.got.includes(code) && !(p.pend || []).some(x => x.c === code)) { p.pend = (p.pend || []).concat([{ c: code, cnt: Math.min(99, cnt), at: now }]).slice(-30); st.link = 1; st.linkCups = Math.min(99, cnt); }
  const tok = crypto.randomBytes(12).toString('hex');
  p.toks = (p.toks || []).concat([sha(tok)]).slice(-6);
  await redis('SET', key, JSON.stringify(p));
  await stat(st, [['ZADD', 'pets', p.cups || 0, key], ['PFADD', 'pact:' + vnDay(now), key]]);
  return tok;
};
module.exports.stat = stat;

const petTag = k => 'Sóc #' + k.slice(-4).toUpperCase();
async function board(per, ph) {
  const z = per === 'all' ? 'pets' : 'petm:' + vnMonth();
  const top = await redis('ZREVRANGE', z, 0, 9, 'WITHSCORES') || [];
  const keys = [], scores = [];
  for (let i = 0; i < top.length; i += 2) { keys.push(top[i]); scores.push(Number(top[i + 1])); }
  const raws = keys.length ? await redis('MGET', ...keys) : [];
  const list = keys.map((k, i) => { let q = {}; try { q = JSON.parse(raws[i] || '{}'); } catch (e) {}
    const eq = q.eq || {}; return { n: q.hide || !q.nm ? petTag(k) : q.nm, lv: levelOf(q.cups || 0).i, cups: scores[i], hat: eq.hat || '', wear: Object.values(eq)[0] || '', house: !!q.house }; }).filter(x => x.cups > 0);
  let me = null;
  if (ph && ph !== DEMO) {
    const k = petKey(ph), r = await pipe([['ZREVRANK', z, k], ['ZSCORE', z, k], ['ZCARD', z]]);
    if (r[0] != null) me = { rank: r[0] + 1, cups: Number(r[1] || 0), of: r[2] };
  }
  return { per, list, me, total: await redis('ZCARD', z) };
}
async function admin(days) {
  const now = Date.now(), ds = []; for (let i = days - 1; i >= 0; i--) ds.push(vnDay(now - i * 86400e3));
  const r = await pipe([...ds.map(d => ['HGETALL', 'pst:' + d]), ...ds.map(d => ['PFCOUNT', 'pact:' + d]),
    ['HGETALL', 'pst:all'], ['ZCARD', 'pets'], ['PFCOUNT', ...ds.slice(-7).map(d => 'pact:' + d)], ['PFCOUNT', ...ds.map(d => 'pact:' + d)],
    ...LEVELS.map((l, i) => ['ZCOUNT', 'pets', l.at, LEVELS[i + 1] ? '(' + LEVELS[i + 1].at : '+inf']),
    ['ZREVRANGE', 'pets', 0, 19, 'WITHSCORES'], ['ZREVRANGE', 'petm:' + vnMonth(), 0, 9, 'WITHSCORES']]);
  const h = a => { const o = {}; for (let i = 0; i < (a || []).length; i += 2) o[a[i]] = Number(a[i + 1]); return o; };
  const n = ds.length, series = ds.map((d, i) => Object.assign({ d, active: r[n + i] || 0 }, h(r[i])));
  let j = 2 * n; const all = h(r[j++]), pets = r[j++] || 0, act7 = r[j++] || 0, actN = r[j++] || 0;
  const lv = LEVELS.map(() => r[j++] || 0); const topRaw = r[j++] || [], monRaw = r[j++] || [];
  const keys = []; for (let i = 0; i < topRaw.length; i += 2) keys.push([topRaw[i], Number(topRaw[i + 1])]);
  const raws = keys.length ? await redis('MGET', ...keys.map(x => x[0])) : [];
  const top = keys.map(([k, c], i) => { let q = {}; try { q = JSON.parse(raws[i] || '{}'); } catch (e) {}
    return { id: k.slice(4), tag: petTag(k), nm: q.nm || '', hide: !!q.hide, house: !!q.house, cups: c, beans: q.beans || 0, lv: levelOf(c).i, born: q.born || 0, fedAt: q.fedAt || 0, items: (q.inv || []).length }; });
  const shop = {}; Object.keys(SHOP).forEach(id => { shop[id] = { p: SHOP[id].p, n: all['buy_' + id] || 0, soon: !!SHOP[id].soon }; });
  return { days, series, all, pets, act7, actN, lv, top, shop, monthTop: monRaw.length / 2 };
}

// ---- sau khi cộng ly: thưởng giới thiệu bạn, mốc tổ sóc ----
async function afterCredit(p, key, now, st) {
  if (p.ref && !p.refPaid) {
    p.refPaid = 1; p.beans = (p.beans || 0) + REF_BONUS; st.ref = 1;
    const rk = 'pet:' + p.ref, rr = await redis('GET', rk);
    if (rr) { const q = JSON.parse(rr); q.beans = (q.beans || 0) + REF_BONUS; q.refN = (q.refN || 0) + 1; await redis('SET', rk, JSON.stringify(q)); }
  }
  if (p.grp) {
    const m = vnMonth(now), gz = 'grpm:' + m;
    const tot = Number(await redis('ZINCRBY', gz, p._cr, p.grp)); await redis('EXPIRE', gz, 120 * 86400);
    const gr = await redis('GET', 'grp:' + p.grp); if (!gr) return;
    const g = JSON.parse(gr); g.paid = g.paid || {}; const done = g.paid[m] || [];
    const hit = GRP_STEPS.filter(x => tot >= x && !done.includes(x));
    if (!hit.length) return;
    g.paid[m] = done.concat(hit); await redis('SET', 'grp:' + p.grp, JSON.stringify(g));
    const bonus = GRP_BONUS * hit.length, others = (g.mem || []).filter(k => k !== key), gift = { at: now, n: bonus, step: hit[hit.length - 1] };
    p.beans = (p.beans || 0) + bonus; p.grpGift = gift; st.gbonus = hit.length;
    if (others.length) { const raws = await redis('MGET', ...others); const cmds = [];
      others.forEach((k, i) => { if (!raws[i]) return; const q = JSON.parse(raws[i]); q.beans = (q.beans || 0) + bonus; q.grpGift = gift; cmds.push(['SET', k, JSON.stringify(q)]); });
      await pipe(cmds); }
  }
}
async function groupView(code, g, ph) {
  const mem = g.mem || [], raws = mem.length ? await redis('MGET', ...mem) : [];
  const m = vnMonth(), r = await pipe([['ZSCORE', 'grpm:' + m, code], ['ZREVRANK', 'grpm:' + m, code]]);
  const month = Number(r[0] || 0), me = ph ? petKey(ph) : '';
  const list = mem.map((k, i) => { let q = {}; try { q = JSON.parse(raws[i] || '{}'); } catch (e) {}
    return { n: q.hide || !q.nm ? petTag(k) : q.nm, lv: levelOf(q.cups || 0).i, cups: q.cups || 0, wear: Object.values(q.eq || {})[0] || '', me: k === me, owner: k === g.owner }; }).sort((a, b) => b.cups - a.cups);
  const next = GRP_STEPS.find(x => x > month) || null;
  return { code, nm: g.nm, list, month, next, steps: GRP_STEPS, bonus: GRP_BONUS, max: GRP_MAX, rank: r[1] == null ? null : r[1] + 1, paid: (g.paid || {})[m] || [] };
}
async function groupBoard() {
  const z = 'grpm:' + vnMonth(), top = await redis('ZREVRANGE', z, 0, 9, 'WITHSCORES') || [];
  const codes = [], sc = []; for (let i = 0; i < top.length; i += 2) { codes.push(top[i]); sc.push(Number(top[i + 1])); }
  const raws = codes.length ? await redis('MGET', ...codes.map(c => 'grp:' + c)) : [];
  const list = codes.map((c, i) => { let g = {}; try { g = JSON.parse(raws[i] || '{}'); } catch (e) {} return { n: g.nm || 'Tổ ' + c, mem: (g.mem || []).length, cups: sc[i] }; }).filter(x => x.cups > 0 && x.mem);
  return { per: 'grp', list, total: await redis('ZCARD', z) };
}
