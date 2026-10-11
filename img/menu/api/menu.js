/* API menu dat nuoc — The Curator Cafe
 * Luu tren Upstash Redis (cung database voi dat nhom / don hang).
 *   menu        -> JSON {v, at, cats:[...]}   menu dang ban
 *   menu:prev   -> ban truoc lan luu gan nhat (de hoan tac)
 *   mimg:<id>   -> anh mon (base64 JPEG/WebP), phuc vu qua /api/menu?img=<id>
 *
 * Cong khai:
 *   GET  /api/menu            -> {cats, v} hoac {cats:null}
 *   GET  /api/menu?js=1       -> window.__MENU = {...};   (nap dong bo truoc script trang)
 *   GET  /api/menu?img=<id>   -> anh
 * Quan tri (1 tai khoan, bien moi truong ADMIN_USER + ADMIN_PASSWORD):
 *   POST {a:'login', u, p}            -> {token}
 *   POST {a:'save', cats, v}          (Bearer token) -> {ok, v}
 *   POST {a:'img', data, type}        (Bearer token) -> {url}
 *   POST {a:'undo'}                   (Bearer token) -> {ok, v}
 */
const crypto = require('crypto');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK_ = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_USER = (process.env.ADMIN_USER || 'admin').trim();
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';
const TOKEN_DAYS = 7;
const MAX_IMG = 450 * 1024; // byte sau khi giai base64

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

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const txt = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const eq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

/* ---------- token quan tri: <het han>.<chu ky> ---------- */
const signKey = () => sha('curator-admin|' + ADMIN_USER + '|' + ADMIN_PASS + '|' + (TOK_ || ''));
function makeToken() {
  const exp = String(Date.now() + TOKEN_DAYS * 86400e3);
  return exp + '.' + crypto.createHmac('sha256', signKey()).update(exp).digest('hex');
}
function tokenOk(req) {
  if (!ADMIN_PASS) return false;
  const h = String(req.headers.authorization || '');
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [exp, sig] = t.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const good = crypto.createHmac('sha256', signKey()).update(exp).digest('hex');
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

/* ---------- kiem tra du lieu menu ---------- */
const BADGES = ['best', 'must', 'new'];
function cleanImg(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (/^\/img\/[\w\-./]{1,120}$/.test(s) && !s.includes('..')) return s;
  if (/^\/api\/menu\?img=[a-f0-9]{16,40}$/.test(s)) return s;
  if (/^https:\/\/[\w\-.]+\/[^\s"'<>]{1,400}$/.test(s)) return s;
  return '';
}
function cleanMenu(cats) {
  if (!Array.isArray(cats)) throw new Error('Menu không hợp lệ');
  const ids = new Set();
  const out = cats.slice(0, 30).map(g => {
    const cat = txt(g && g.cat, 40);
    if (!cat) throw new Error('Có loại chưa đặt tên');
    const items = (Array.isArray(g.items) ? g.items : []).slice(0, 150).map(i => {
      const id = String(i && i.id || '').toLowerCase();
      if (!/^[a-z0-9]{1,40}$/.test(id)) throw new Error('Mã món không hợp lệ: ' + id);
      if (ids.has(id)) throw new Error('Trùng mã món: ' + id);
      ids.add(id);
      const n = txt(i.n, 60);
      if (!n) throw new Error('Có món chưa đặt tên trong loại ' + cat);
      const p = Math.floor(Number(i.p));
      if (!(p >= 0 && p <= 5e6)) throw new Error('Giá không hợp lệ: ' + n);
      const b = String(i.b || '').split(',').filter(x => BADGES.includes(x));
      const it = { id, n, p, d: txt(i.d, 160), b: [...new Set(b)].join(',') };
      const img = cleanImg(i.img); if (img) it.img = img;
      if (i.h) it.h = 1;
      if (i.so) it.so = 1;
      return it;
    });
    const o = { cat, sub: txt(g.sub, 80), items };
    if (g.lib === true) o.lib = true; else if (g.lib === false) o.lib = false;
    if (g.h) o.h = 1;
    return o;
  });
  if (!out.length) throw new Error('Menu phải có ít nhất 1 loại');
  return out;
}

async function getMenu() {
  const raw = await redis('GET', 'menu');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') { try { return Promise.resolve(JSON.parse(req.body || '{}')); } catch (e) { return Promise.resolve({}); } }
  return new Promise((ok) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1.5e6) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { ok({}); } });
  });
}

const send = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
};

module.exports = async (req, res) => {
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const ready = !!(URL_ && TOK_);

  if (req.method === 'GET') {
    /* anh mon */
    if (q.img) {
      const id = String(q.img);
      if (!ready || !/^[a-f0-9]{16,40}$/.test(id)) { res.statusCode = 404; return res.end(); }
      try {
        const v = await redis('GET', 'mimg:' + id);
        if (!v) { res.statusCode = 404; return res.end(); }
        const [type, b64] = String(v).split('|');
        res.statusCode = 200;
        res.setHeader('Content-Type', type === 'webp' ? 'image/webp' : 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.end(Buffer.from(b64, 'base64'));
      } catch (e) { res.statusCode = 500; return res.end(); }
    }
    let m = null;
    if (ready) { try { m = await getMenu(); } catch (e) { m = null; } }
    const pub = m ? { v: m.v, cats: m.cats } : { cats: null };
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'max-age=5, stale-while-revalidate=30');
    if (q.js) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      return res.end('window.__MENU=' + JSON.stringify(pub).replace(/</g, '\\u003c') + ';');
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify(pub));
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'Phương thức không hỗ trợ' });
  if (!ready) return send(res, 503, { error: 'Chưa gắn Upstash Redis cho dự án (tab Storage trên Vercel).' });
  if (!ADMIN_PASS) return send(res, 503, { error: 'Chưa đặt biến môi trường ADMIN_PASSWORD trên Vercel.' });

  const body = await readBody(req);
  const a = body.a;

  try {
    if (a === 'login') {
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
      const rk = 'adm:try:' + crypto.createHash('sha1').update(ip).digest('hex').slice(0, 16);
      const n = await redis('INCR', rk);
      if (n === 1) await redis('EXPIRE', rk, 900);
      if (n > 10) return send(res, 429, { error: 'Sai quá nhiều lần. Thử lại sau 15 phút.' });
      if (!eq(txt(body.u, 60), ADMIN_USER) || !eq(String(body.p || ''), ADMIN_PASS))
        return send(res, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu' });
      await redis('DEL', rk);
      return send(res, 200, { token: makeToken(), days: TOKEN_DAYS });
    }

    if (!tokenOk(req)) return send(res, 401, { error: 'Phiên đăng nhập đã hết, đăng nhập lại.' });

    if (a === 'check') return send(res, 200, { ok: true });

    if (a === 'save') {
      const cats = cleanMenu(body.cats);
      const cur = await getMenu();
      const curV = cur ? cur.v : 0;
      if (Number(body.v || 0) !== curV)
        return send(res, 409, { error: 'Menu vừa được sửa ở nơi khác. Tải lại trang quản trị rồi sửa lại.', v: curV });
      const next = { v: curV + 1, at: Date.now(), cats };
      if (cur) await redis('SET', 'menu:prev', JSON.stringify(cur));
      await redis('SET', 'menu', JSON.stringify(next));
      return send(res, 200, { ok: true, v: next.v });
    }

    if (a === 'undo') {
      const prev = await redis('GET', 'menu:prev');
      if (!prev) return send(res, 404, { error: 'Không có bản trước để hoàn tác' });
      const cur = await getMenu();
      const p = JSON.parse(prev);
      const next = { v: (cur ? cur.v : 0) + 1, at: Date.now(), cats: p.cats };
      if (cur) await redis('SET', 'menu:prev', JSON.stringify(cur));
      await redis('SET', 'menu', JSON.stringify(next));
      return send(res, 200, { ok: true, v: next.v, cats: next.cats });
    }

    if (a === 'img') {
      const type = body.type === 'webp' ? 'webp' : 'jpg';
      const b64 = String(body.data || '').replace(/^data:image\/[a-z]+;base64,/, '');
      if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return send(res, 400, { error: 'Ảnh không hợp lệ' });
      const buf = Buffer.from(b64, 'base64');
      const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
      const isWebp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
      if (!(isJpg || isWebp)) return send(res, 400, { error: 'Chỉ nhận ảnh JPEG hoặc WebP' });
      if (buf.length > MAX_IMG) return send(res, 413, { error: 'Ảnh quá lớn' });
      const id = crypto.randomBytes(12).toString('hex');
      await redis('SET', 'mimg:' + id, (isWebp ? 'webp' : 'jpg') + '|' + b64);
      return send(res, 200, { url: '/api/menu?img=' + id });
    }

    return send(res, 400, { error: 'Yêu cầu không hợp lệ' });
  } catch (e) {
    return send(res, 400, { error: e.message || 'Lỗi' });
  }
};
