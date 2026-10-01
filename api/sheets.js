/* Proxy doc CSV Google Sheets cho trang quay — nhanh hon goi thang tu dien thoai.
 * Chi nhan link "Xuat ban len web" dang CSV cua docs.google.com (khong phai proxy mo).
 * Vercel CDN giu ban sao 5 giay, cac may quay dung chung nen moi lan lam moi gan nhu tuc thi.
 */
const OK = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/[A-Za-z0-9_-]{20,}\/pub\?[A-Za-z0-9_=&.-]*output=csv[A-Za-z0-9_=&.-]*$/;

async function get(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 8000);
  try {
    const job = (async () => {
      const r = await fetch(url, { signal: c.signal, redirect: 'follow', headers: { 'User-Agent': 'curator-cashier' } });
      return r.ok ? await r.text() : null;
    })();
    return await Promise.race([job, new Promise(r => setTimeout(() => r(null), 8000))]);
  } catch (e) { return null; } finally { clearTimeout(t); }
}

module.exports = async (req, res) => {
  const want = {};
  for (const k of ['nuoc', 'banh', 'sync']) {
    const u = String(req.query[k] || '');
    if (u && OK.test(u)) want[k] = u;
  }
  if (!Object.keys(want).length) return res.status(400).json({ ok: false, err: 'Thiếu liên kết CSV hợp lệ.' });
  const keys = Object.keys(want);
  const texts = await Promise.all(keys.map(k => get(want[k])));
  const data = {}; let miss = 0;
  keys.forEach((k, i) => { if (texts[i] != null) data[k] = texts[i]; else miss++; });
  // co nguon loi thi khong cho CDN giu lau
  res.setHeader('Cache-Control', miss ? 'no-store' : 'public, max-age=0, s-maxage=5, stale-while-revalidate=20');
  res.setHeader('X-Robots-Tag', 'noindex');
  return res.status(200).json({ ok: true, t: Date.now(), data });
};
