import { Router, type NextFunction, type Request, type Response } from 'express';

import {
  ALL_SKUS,
  SKU_FREE_PER_MONTH,
  SKU_PRICE_USD,
  recentMapsEvents,
  spendReport,
} from './budget.js';
import { isGoogleEnabled } from './google.js';

/**
 * A local, live view of what the Maps layer is spending.
 *
 * Development only (mounted from app.ts behind NODE_ENV === 'development'),
 * and only to the machine itself: the phone on the same network can reach the
 * API, but not this page. It counts what *this* server sent — the official
 * figures, hours behind, are in Cloud Console.
 *
 * The page is a static HTML file plus a script served from the same origin,
 * because helmet's CSP (script-src 'self') blocks inline scripts.
 */
export const mapsDashboardRouter = Router();

function localOnly(req: Request, res: Response, next: NextFunction): void {
  const ip = req.socket.remoteAddress ?? '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!loopback) {
    res.status(404).end();
    return;
  }
  // helmet's default CSP carries `upgrade-insecure-requests`, which would send
  // the page's own script and polling to https://localhost and break it. Same
  // rules otherwise: nothing loads from anywhere but this server.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  );
  next();
}

const SKU_LABELS: Record<string, { he: string; what: string }> = {
  geocoding: { he: 'חיפוש כתובת', what: 'Geocoding: טקסט ← מיקום' },
  routes_essentials: { he: 'מסלול רגיל', what: 'Routes Essentials: בלי פקקים' },
  routes_pro: { he: 'מסלול עם פקקים', what: 'Routes Pro: "זמן לצאת"' },
  nearby_pro: { he: 'מקומות קרובים', what: 'Places Pro: כשהקובץ המקומי ריק' },
  nearby_enterprise: { he: 'פתוח עכשיו', what: 'Places Enterprise: שעות פתיחה' },
};

mapsDashboardRouter.get('/maps/usage', localOnly, (_req, res) => {
  const report = spendReport();
  res.set('Cache-Control', 'no-store').json({
    googleEnabled: isGoogleEnabled(),
    report,
    skus: ALL_SKUS.map((sku) => ({
      sku,
      ...SKU_LABELS[sku],
      pricePer1000: Math.round(SKU_PRICE_USD[sku] * 1000 * 100) / 100,
      freePerMonth: SKU_FREE_PER_MONTH[sku],
      day: report.dayCount[sku],
      month: report.monthCount[sku],
    })),
    events: recentMapsEvents(),
  });
});

mapsDashboardRouter.get('/maps/dashboard', localOnly, (_req, res) => {
  res.set('Cache-Control', 'no-store').type('html').send(PAGE);
});

mapsDashboardRouter.get('/maps/dashboard.js', localOnly, (_req, res) => {
  res.set('Cache-Control', 'no-store').type('application/javascript').send(SCRIPT);
});

const PAGE = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Google Maps · שימוש</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #ffffff; --ink: #14181f; --muted: #667085;
    --line: #e4e7ec; --track: #eef0f3; --blue: #2563eb; --green: #16a34a;
    --amber: #d97706; --red: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117; --card: #161b22; --ink: #e6edf3; --muted: #8b949e;
      --line: #30363d; --track: #21262d; --blue: #58a6ff; --green: #3fb950;
      --amber: #d29922; --red: #f85149;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Arial, sans-serif; }
  main { max-width: 1040px; margin: 0 auto; padding: 24px 16px 48px; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; margin-bottom: 20px; }
  h1 { font-size: 22px; margin: 0; }
  .status { font-size: 13px; color: var(--muted); }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; }
  .pill.on { background: color-mix(in srgb, var(--green) 15%, transparent); color: var(--green); }
  .pill.off { background: color-mix(in srgb, var(--amber) 15%, transparent); color: var(--amber); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .tile, .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .tile .k { font-size: 13px; color: var(--muted); }
  .tile .v { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .tile .s { font-size: 12px; color: var(--muted); }
  h2 { font-size: 16px; margin: 0 0 10px; }
  .card { margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { font-size: 12px; color: var(--muted); font-weight: 600; }
  tr:last-child td { border-bottom: 0; }
  .what { font-size: 12px; color: var(--muted); }
  .bar { height: 8px; background: var(--track); border-radius: 999px; overflow: hidden; min-width: 120px; }
  .bar > i { display: block; height: 100%; background: var(--blue); border-radius: 999px; }
  .bar.warn > i { background: var(--amber); } .bar.over > i { background: var(--red); }
  .num { white-space: nowrap; }
  .scroll { overflow-x: auto; }
  .ev { display: grid; grid-template-columns: 64px 118px 1fr; gap: 10px; padding: 7px 0;
    border-bottom: 1px solid var(--line); font-size: 14px; align-items: center; }
  .ev:last-child { border-bottom: 0; }
  .ev time { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 13px; }
  .tag { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 6px; text-align: center; }
  .tag.google { background: color-mix(in srgb, var(--blue) 15%, transparent); color: var(--blue); }
  .tag.free, .tag.cache, .tag.gate { background: color-mix(in srgb, var(--green) 15%, transparent); color: var(--green); }
  .tag.blocked, .tag.google_failed { background: color-mix(in srgb, var(--red) 15%, transparent); color: var(--red); }
  .empty { color: var(--muted); padding: 12px 0; }
  .note { font-size: 12px; color: var(--muted); margin-top: 8px; }
  @media (max-width: 560px) { .ev { grid-template-columns: 56px 1fr; } .ev .label { grid-column: 1 / -1; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>Google Maps · שימוש בזמן אמת</h1>
    <span id="enabled" class="pill off">…</span>
    <span class="status" id="updated">מתחבר…</span>
  </header>

  <section class="tiles">
    <div class="tile"><div class="k">עלות היום (מחיר מלא)</div><div class="v" id="daySpend">–</div><div class="s" id="dayBudget"></div></div>
    <div class="tile"><div class="k">לתשלום החודש (מעבר לחינם)</div><div class="v" id="billable">–</div><div class="s">כל עוד זה $0, לא משלמים כלום</div></div>
    <div class="tile"><div class="k">בקשות ששולמו החודש</div><div class="v" id="paidMonth">–</div><div class="s" id="paidDay"></div></div>
    <div class="tile"><div class="k">נענו בחינם החודש</div><div class="v" id="saved">–</div><div class="s">זיכרון, קובץ מקומי, חישוב בקו אוויר</div></div>
  </section>

  <section class="card">
    <h2>מכסה חינמית לפי שירות</h2>
    <div class="scroll">
      <table>
        <thead><tr><th>שירות</th><th>היום</th><th>החודש</th><th>מתוך המכסה החינמית</th><th>נשארו</th><th>אחרי המכסה</th></tr></thead>
        <tbody id="skus"></tbody>
      </table>
    </div>
    <p class="note">הספירה היא של השרת המקומי בלבד, ונשמרת בין הפעלות (backend/data/maps-usage.json). המספרים הרשמיים מופיעים ב-Google Cloud Console באיחור של כמה שעות.</p>
  </section>

  <section class="card">
    <h2>בקשות אחרונות</h2>
    <div id="events"><div class="empty">עדיין אין בקשות. תשתמש באפליקציה והן יופיעו כאן.</div></div>
  </section>
</main>
<script src="/maps/dashboard.js"></script>
</body>
</html>`;

const SCRIPT = `(() => {
  const $ = (id) => document.getElementById(id);
  const usd = (n) => '$' + (Math.round(n * 1000) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });
  const int = (n) => n.toLocaleString('he-IL');
  const KIND = {
    google: 'Google, שולם', google_failed: 'Google, נכשל', blocked: 'נחסם בתקרה',
    cache: 'מהזיכרון, חינם', free: 'מקומי, חינם', gate: 'קו אוויר, חינם',
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render(d) {
    const r = d.report;
    $('enabled').textContent = d.googleEnabled ? 'Google פעיל' : 'Google כבוי, הכול חינמי';
    $('enabled').className = 'pill ' + (d.googleEnabled ? 'on' : 'off');
    $('daySpend').textContent = usd(r.daySpendUsd);
    $('dayBudget').textContent = 'תקרה יומית בקוד: ' + usd(r.dailyBudgetUsd);
    $('billable').textContent = usd(r.monthBillableUsd);
    const paidMonth = d.skus.reduce((a, s) => a + s.month, 0);
    const paidDay = d.skus.reduce((a, s) => a + s.day, 0);
    $('paidMonth').textContent = int(paidMonth);
    $('paidDay').textContent = 'היום: ' + int(paidDay);
    $('saved').textContent = int(r.monthSaved);

    $('skus').innerHTML = d.skus.map((s) => {
      const pct = Math.min(100, (s.month / s.freePerMonth) * 100);
      const cls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
      const left = Math.max(0, s.freePerMonth - s.month);
      return '<tr>' +
        '<td><div>' + esc(s.he) + '</div><div class="what">' + esc(s.what) + '</div></td>' +
        '<td class="num">' + int(s.day) + '</td>' +
        '<td class="num">' + int(s.month) + '</td>' +
        '<td><div class="bar ' + cls + '" title="' + pct.toFixed(2) + '%"><i style="width:' + Math.max(pct, s.month ? 1 : 0) + '%"></i></div>' +
        '<div class="what">' + int(s.month) + ' / ' + int(s.freePerMonth) + '</div></td>' +
        '<td class="num">' + int(left) + '</td>' +
        '<td class="num">$' + s.pricePer1000 + ' לאלף</td>' +
      '</tr>';
    }).join('');

    $('events').innerHTML = d.events.length
      ? d.events.map((e) => {
          const t = new Date(e.at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          return '<div class="ev"><time>' + t + '</time><span class="tag ' + e.kind + '">' + (KIND[e.kind] || e.kind) +
            '</span><span class="label">' + esc(e.label) + '</span></div>';
        }).join('')
      : '<div class="empty">עדיין אין בקשות. תשתמש באפליקציה והן יופיעו כאן.</div>';

    $('updated').textContent = 'עודכן ' + new Date().toLocaleTimeString('he-IL');
  }

  async function tick() {
    try {
      const res = await fetch('/maps/usage', { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      render(await res.json());
    } catch {
      $('updated').textContent = 'השרת לא עונה. הוא רץ?';
    }
  }
  tick();
  setInterval(tick, 2000);
})();`;
