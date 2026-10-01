/* API kiem kho — The Curator Cafe
 *   kho:items -> JSON danh sach mat hang [{k,n,role,unit,min}]
 *   kho:last  -> hash k -> {q,at,by}   (so dem gan nhat moi mat hang)
 *   kho:log   -> list cac lan kiem (moi nhat o dau, giu 600 lan)
 * Moi thao tac can ma PIN quay (bien moi truong STAFF_PIN).
 */
const crypto = require('crypto');
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK_ = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PIN = process.env.STAFF_PIN || '';

const DEFAULT_ITEMS = [
  { k: 'ly-cf-muoi', n: 'Ly cà phê muối', role: 'pha', unit: 'cái', min: 20 },
  { k: 'ly-matcha',  n: 'Ly matcha',      role: 'pha', unit: 'cái', min: 30 },
  { k: 'ly-tra',     n: 'Ly trà',         role: 'pha', unit: 'cái', min: 40 },
  { k: 'ly-coldbrew',n: 'Ly cold brew',   role: 'pha', unit: 'cái', min: 20 },
  { k: 'ly-tra-da',  n: 'Ly trà đá',      role: 'thu', unit: 'cái', min: 40 },
  { k: 'ly-tra-inox',n: 'Ly trà inox',    role: 'thu', unit: 'cái', min: 20 },
];

async function redis(...cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOK_, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const pinOk = p => PIN && typeof p === 'string' && p.length >= 4 && crypto.timingSafeEqual(Buffer.from(sha(p)), Buffer.from(sha(PIN)));
const txt = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const slug = s => txt(s, 40).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const VN = 7 * 3600e3;
const dayStart = t => Math.floor((t + VN) / 86400e3) * 86400e3 - VN;     // 0h theo gio Viet Nam
const csvKey = () => sha('kho-csv:' + PIN).slice(0, 24);
const REASON = { ban: 'Bán/dùng trong ngày', be: 'Bể/hỏng', nham: 'Đếm nhầm lần trước', nhap: 'Nhập hàng thêm', kho: 'Lấy từ kho dự trữ', khac: 'Khác' };
const pad = x => String(x).padStart(2, '0');
function vnTime(t) { const d = new Date(t + VN); return { d: pad(d.getUTCDate()) + '/' + pad(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear(), h: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) }; }
const cell = v => { const x = String(v == null ? '' : v); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
/* moc so sanh "hom qua": lan kiem gan nhat TRUOC 0h hom nay cua tung mat hang */
function baselines(log, before) {
  const out = {};
  for (const r of log) { if (r.at >= before) continue; for (const k in r.counts) if (!out[k]) out[k] = { q: r.counts[k], at: r.at, by: r.by }; }
  return out;
}
async function getItems() {
  const x = await redis('GET', 'kho:items');
  try { const a = JSON.parse(x); if (Array.isArray(a) && a.length) return a; } catch (e) {}
  return DEFAULT_ITEMS;
}
async function state() {
  const [items, lastRaw, logRaw] = await Promise.all([getItems(), redis('HGETALL', 'kho:last'), redis('LRANGE', 'kho:log', 0, 199)]);
  const last = {};
  for (let i = 0; i < (lastRaw || []).length; i += 2) { try { last[lastRaw[i]] = JSON.parse(lastRaw[i + 1]); } catch (e) {} }
  const log = (logRaw || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
  const base = baselines(log, dayStart(Date.now()));
  return { items, last, log, base, csvKey: csvKey() };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const send = (c, b) => res.status(c).json(b);
  if (!URL_ || !TOK_) return send(503, { ok: false, err: 'Chưa kết nối cơ sở dữ liệu.' });
  if (!PIN) return send(503, { ok: false, err: 'Chưa đặt STAFF_PIN trên Vercel.' });
  try {
    /* Xuat CSV cho Google Sheets: =IMPORTDATA("https://www.thecuratorcafe.vn/api/kho?csv=KHOA") */
    if (req.method === 'GET' && req.query.csv) {
      if (String(req.query.csv) !== csvKey()) return res.status(403).send('Sai khoa');
      const [items, logRaw] = await Promise.all([getItems(), redis('LRANGE', 'kho:log', 0, 599)]);
      const name = {}; items.forEach(i => name[i.k] = i.n);
      const log = (logRaw || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
      const rows = [];
      if (req.query.view === 'ton') {
        const lastRaw = await redis('HGETALL', 'kho:last'); const last = {};
        for (let i = 0; i < (lastRaw || []).length; i += 2) { try { last[lastRaw[i]] = JSON.parse(lastRaw[i + 1]); } catch (e) {} }
        const base = baselines(log, dayStart(Date.now()));
        rows.push(['Mặt hàng', 'Ai kiểm', 'Tồn hiện tại', 'Hôm qua', 'Tăng/giảm', 'Mức tối thiểu', 'Trạng thái', 'Kiểm lúc', 'Người kiểm cuối']);
        items.forEach(i => { const l = last[i.k], b = base[i.k], t = l ? vnTime(l.at) : null;
          const d = l && b && b.at !== l.at ? l.q - b.q : '';
          rows.push([i.n, i.role === 'thu' ? 'Thu ngân' : 'Pha chế', l ? l.q : '', b ? b.q : '', d, i.min, !l ? 'Chưa kiểm' : l.q === 0 ? 'Hết' : l.q <= i.min ? 'Sắp hết' : 'Đủ', t ? t.d + ' ' + t.h : '', l ? l.by : '']); });
      } else {
        rows.push(['Ngày', 'Giờ', 'Người kiểm', 'Vai trò', 'Mặt hàng', 'Hôm qua', 'Hôm nay', 'Chênh lệch', 'Tăng/Giảm', 'Lý do', 'Chi tiết lý do', 'Ghi chú']);
        log.forEach(r => { const t = vnTime(r.at);
          Object.keys(r.counts).forEach(k => {
            const b = (r.base ? r.base[k] : baselines(log, dayStart(r.at))[k]) || null, q = r.counts[k], d = b ? q - b.q : '';
            const rs = (r.reasons && r.reasons[k]) || {};
            rows.push([t.d, t.h, r.by, r.role === 'thu' ? 'Thu ngân' : 'Pha chế', name[k] || k, b ? b.q : '', q, d,
              d === '' ? 'Lần đầu' : d > 0 ? 'Tăng' : d < 0 ? 'Giảm' : 'Không đổi', rs.r ? (REASON[rs.r] || rs.r) : '', rs.t || '', r.note || '']);
          });
        });
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.status(200).send(rows.map(r => r.map(cell).join(',')).join('\n'));
    }
    const b = req.method === 'POST' ? (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})) : {};
    if (!pinOk(req.headers['x-staff-pin'] || b.pin)) return send(403, { ok: false, err: 'Sai mã PIN.' });

    if (req.method === 'GET') return send(200, Object.assign({ ok: true }, await state()));
    if (req.method !== 'POST') return send(405, { ok: false });
    const now = Date.now();

    if (b.a === 'count') {
      const items = await getItems();
      const by = txt(b.by, 30); if (!by) return send(400, { ok: false, err: 'Nhập tên người kiểm.' });
      const role = b.role === 'thu' ? 'thu' : 'pha';
      const counts = {}, prev = {};
      const lastRaw = await redis('HGETALL', 'kho:last'); const last = {};
      for (let i = 0; i < (lastRaw || []).length; i += 2) { try { last[lastRaw[i]] = JSON.parse(lastRaw[i + 1]); } catch (e) {} }
      items.forEach(it => {
        const v = b.counts && b.counts[it.k];
        if (v === '' || v == null) return;
        const q = Math.floor(Number(v));
        if (Number.isFinite(q) && q >= 0 && q <= 100000) { counts[it.k] = q; if (last[it.k]) prev[it.k] = last[it.k]; }
      });
      if (!Object.keys(counts).length) return send(400, { ok: false, err: 'Chưa nhập số lượng nào.' });
      const logRaw = await redis('LRANGE', 'kho:log', 0, 599);
      const log = (logRaw || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
      const allBase = baselines(log, dayStart(now)), base = {}, reasons = {};
      Object.keys(counts).forEach(k => {
        if (allBase[k]) base[k] = allBase[k];
        const rs = b.reasons && b.reasons[k];
        if (rs && (rs.r || rs.t)) reasons[k] = { r: REASON[rs.r] ? rs.r : 'khac', t: txt(rs.t, 120) };
      });
      const rec = { id: now.toString(36) + crypto.randomBytes(2).toString('hex'), at: now, by, role, counts, prev, base, reasons, note: txt(b.note, 200) };
      await redis('LPUSH', 'kho:log', JSON.stringify(rec));
      await redis('LTRIM', 'kho:log', 0, 599);
      const args = []; Object.keys(counts).forEach(k => args.push(k, JSON.stringify({ q: counts[k], at: now, by })));
      await redis('HSET', 'kho:last', ...args);
      return send(200, Object.assign({ ok: true, rec }, await state()));
    }

    if (b.a === 'items') {
      if (!Array.isArray(b.items) || !b.items.length) return send(400, { ok: false, err: 'Danh sách trống.' });
      const seen = new Set();
      const items = b.items.slice(0, 60).map(i => {
        const n = txt(i && i.n, 40); if (!n) return null;
        let k = txt(i.k, 40) || slug(n); if (!k || seen.has(k)) k = slug(n) + '-' + crypto.randomBytes(2).toString('hex');
        seen.add(k);
        return { k, n, role: i.role === 'thu' ? 'thu' : 'pha', unit: txt(i.unit, 12) || 'cái', min: Math.max(0, Math.min(100000, Math.floor(Number(i.min) || 0))) };
      }).filter(Boolean);
      await redis('SET', 'kho:items', JSON.stringify(items));
      return send(200, Object.assign({ ok: true }, await state()));
    }

    if (b.a === 'undo') {   // xoa lan kiem vua nhap nham (trong 30 phut)
      const logRaw = await redis('LRANGE', 'kho:log', 0, 0);
      const top = logRaw && logRaw[0] ? JSON.parse(logRaw[0]) : null;
      if (!top || top.id !== b.id || now - top.at > 30 * 60e3) return send(400, { ok: false, err: 'Chỉ huỷ được lần kiểm mới nhất trong 30 phút.' });
      await redis('LPOP', 'kho:log');
      const args = [], del = [];
      Object.keys(top.counts).forEach(k => { if (top.prev && top.prev[k]) args.push(k, JSON.stringify(top.prev[k])); else del.push(k); });
      if (args.length) await redis('HSET', 'kho:last', ...args);
      if (del.length) await redis('HDEL', 'kho:last', ...del);
      return send(200, Object.assign({ ok: true }, await state()));
    }
    return send(400, { ok: false, err: 'Thao tác không hợp lệ.' });
  } catch (e) {
    console.error(e);
    return send(500, { ok: false, err: 'Lỗi máy chủ.' });
  }
};
