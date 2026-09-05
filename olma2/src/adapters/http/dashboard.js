'use strict';
// Admin dashboard v2 — zero deps, server-rendered HTML, form POSTs. Reads the
// same domain/tables as the MCP adapter; renders pre-aggregated snapshots
// (usage_ledger, product_metrics_daily, job_heartbeats), never raw scans.
//
// Security (decided): Basic Auth stays while there's one admin, but every
// mutating POST is CSRF-protected via double-submit (SameSite=Strict cookie +
// matching form field) — Basic Auth alone is CSRF-able from any browser tab.
const { OPENCLAW_CONFIG_PATH } = require('./admin/env');
const { GROUPS, SECTIONS } = require('./admin/sections/index');
const { publicGateway, collectAlerts, renderAlerts } = require('./admin/sections/health');
const { FLAG_SPECS, EDITABLE_FLAGS } = require('./admin/sections/controls');
const { renderContactsPage } = require('./admin/contacts');
const { renderUserPage } = require('./admin/user-page');
const { safeBack, handleUserEdit } = require('./admin/posts');
const { STYLE, oauthResultPage } = require('./admin/html');
const http = require('node:http');
const crypto = require('node:crypto');
const flagsDomain = require('../../domain/flags');
const occ = require('../../intake/openclaw-config');
const boostDomain = require('../../domain/boost');
const boostJob = require('../../jobs/boost');
const issuesDomain = require('../../domain/issues');
const auditDomain = require('../../domain/audit');
const dashboardAuth = require('../../domain/dashboard-auth');
const { refreshUserCard } = require('../../intake/user-card');
const { withTx } = require('../../db/pool');
const { assessJobs } = require('../../jobs/expectations');
const { deprovisionUser } = require('../../intake/deprovision');
const picker = require('./picker');
const userDashboard = require('./user-dashboard');
const publicPages = require('./public-pages');
const { checkGateway } = require('../gateway-health');

// /ready's whole test. brokerd beats immediately on boot and then every 60s,
// so three intervals is generous enough that an ordinary slow tick under load
// never fails a deploy, and tight enough that a daemon which died on boot
// cannot coast on the previous process's beat.
const BROKERD_BEAT_MAX_AGE_S = 180;

function checkBasicAuth(req, user, pass) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  return eq(u || '', user) && eq(p || '', pass);
}

function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? m[1] : null;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 64_000) req.destroy(); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b))));
  });
}

// configPath is injectable so tests can exercise deletion against a temp
// openclaw.json instead of the live gateway's. calendarDomain/googleOpts are
// injectable so the OAuth flow can be tested without network access — and are
// required lazily, so a box with no /opt/olma still starts a dashboard.
function createDashboard({ pool, adminUser, adminPass, configPath, calendarDomain, googleContactsDomain, mailDomain, googleConnectDomain, googleOpts, gatewayCheck, gatewayCacheMs, publicHosts }) {
  const calendar = () => calendarDomain || require('../../domain/calendar');
  const googleContacts = () => googleContactsDomain || require('../../domain/google-contacts');
  const mail = () => mailDomain || require('../../domain/mail');
  const googleConnect = () => googleConnectDomain || require('../../domain/google-connect');

  // The table the /oauth/google/callback route dispatches on — see the route
  // for what each column means. Keyed by the `provider` an oauth_states row
  // was minted with, so a state minted for one product can never be redeemed
  // as another. `success(data)` returns [title, body] for the result page.
  const OAUTH_PROVIDERS = {
    google_calendar: {
      flow: calendar,
      refreshesCard: () => true,
      success: (d) => ['היומן חובר ✅', d.accessLevel === 'read_write'
        ? 'עולמה יכולה לראות את היומן שלך וגם להוסיף ולערוך אירועים. אפשר לחזור לוואטסאפ.'
        : 'עולמה יכולה לראות את היומן שלך בלבד — היא לא תוכל לשנות בו דבר. אפשר לחזור לוואטסאפ.'],
    },
    gmail: {
      flow: mail,
      refreshesCard: () => true,
      success: () => ['תיבת המייל חוברה ✅', 'עולמה יכולה לחפש במיילים שלך כשתבקש — היא לא עוברת עליהם מיוזמתה, ולא יכולה לשלוח, להשיב או למחוק כלום. אפשר לחזור לוואטסאפ.'],
    },
    google_contacts: {
      flow: googleContacts,
      refreshesCard: () => false,
      success: () => ['אנשי הקשר חוברו ✅', 'עולמה תייבא אותם עכשיו ותעדכן אותך בוואטסאפ כמה נשמרו. אפשר לחזור לשם.'],
    },
    google_connect: {
      flow: googleConnect,
      refreshesCard: (d) => Boolean(d.connected && (d.connected.calendar || d.connected.mail)),
      success: (d) => {
        const got = d.connectedLabel || [];
        const missingHe = { calendar: 'יומן', contacts: 'אנשי קשר', mail: 'מייל' };
        const missed = (d.missing || []).map((k) => missingHe[k] || k);
        const gotLine = got.length ? `חובר: ${got.join(', ')}.` : '';
        const missLine = missed.length
          ? ` לא סומן בגוגל ולכן לא חובר: ${missed.join(', ')} — אפשר לבקש קישור חדש ולסמן גם את זה.`
          : '';
        return ['החיבור לגוגל הושלם ✅', `${gotLine}${missLine} אפשר לחזור לוואטסאפ.`.trim()];
      },
    },
  };

  // Which hostnames get the PUBLIC home page at `/` instead of the admin
  // dashboard. Injectable so the suite can prove both halves without owning
  // DNS; the default is the real public domain and its www form.
  const PUBLIC_HOSTS = new Set(publicHosts || ['allma.world', 'www.allma.world']);
  // Host arrives as "name" or "name:port", and a client controls it. Only ever
  // used to decide public-page-or-dashboard, and it can only ever REMOVE
  // access (an unrecognised host falls through to Basic Auth), so a forged
  // value cannot reach anything the password protects.
  const hostOf = (req) => String(req.headers.host || '').split(':')[0].toLowerCase();

  // Injectable so a test states the gateway's condition instead of inheriting
  // whatever is running on the machine — the suite runs ON the production box
  // (deploy.sh), where the real probe would be green for real, and on CI
  // runners with no gateway at all, where it would be `unknown`. Neither
  // proves the branch under test.
  const probeGateway = gatewayCheck
    || (() => checkGateway({ configPath: configPath || OPENCLAW_CONFIG_PATH }));

  // /health is unauthenticated, and the gateway probe it now runs is an
  // outbound request. Without this a flood of /health hits would be amplified
  // one-for-one into the gateway — the process the check exists to protect.
  // Five seconds is far shorter than any monitor's interval, so a real
  // operator or uptime check still sees the current state.
  let gatewayCache = { at: 0, value: null };
  const cacheMs = Number.isFinite(gatewayCacheMs) ? gatewayCacheMs : 5000;
  async function cachedGateway() {
    const now = Date.now();
    if (gatewayCache.value && now - gatewayCache.at < cacheMs) return gatewayCache.value;
    // A probe that THREW must not take the whole endpoint down with it: the
    // page's job is to report, and "the check itself broke" is `unknown`, not
    // an outage.
    let value;
    try { value = await probeGateway(); }
    catch (e) { value = { status: 'unknown', detail: `probe failed: ${e.message}`, port: null }; }
    gatewayCache = { at: now, value };
    return value;
  }

  const server = http.createServer(async (req, res) => {
    try {
      // ---- public routes, ahead of Basic Auth ----------------------------
      // Google redirects the USER's browser here, so this cannot sit behind
      // the admin password. It is safe to expose because it grants nothing on
      // its own: it acts only on a `state` we minted — random, single-use,
      // 15-minute TTL, bound to one user and one access level — and that state
      // is redeemed BEFORE any call to Google, so an invalid one costs a
      // static 400 and no outbound request.
      //
      // Exact pathname compare, never a prefix: req.url is attacker-supplied.
      // (/health above compares the raw string only because it never carries a
      // query; this route always does.)
      const parsed = new URL(req.url, 'http://x');
      if (req.method === 'GET' && parsed.pathname === '/oauth/google/callback') {
        const q = parsed.searchParams;
        const state = q.get('state');
        // A plain read, before either domain redeems anything: which provider
        // this state was minted for decides which module's completeOAuth gets
        // to burn it. Redemption itself stays atomic and provider-filtered
        // inside each completeOAuth, so a missing/unknown state just falls
        // through to calendar's existing bad_state answer — this peek only
        // ever narrows which module is asked, never grants anything.
        let provider = 'google_calendar';
        if (state) {
          try {
            const { rows } = await pool.query(`SELECT provider FROM oauth_states WHERE state = $1`, [state]);
            if (rows[0]) provider = rows[0].provider;
          } catch { /* fall through to calendar's own bad_state answer */ }
        }
        // One row per Google product that lands on this callback — the
        // fourth arrived as a fourth boolean flag, which is how a route like
        // this stops being readable. Anything unrecognised falls through to
        // the calendar row, exactly as before. Each row says three things:
        // which domain module redeems the state, whether a success changed
        // something USER.md carries, and what the person is shown.
        //
        // `refreshesCard`: connecting here happens over HTTP, outside any
        // tool call, so brokerd's per-tool card refresh never sees it — the
        // card carries calendar and mail state (the agent reads it every
        // turn), so those refresh after the commit, the same rule as every
        // card write. Contacts is the deliberate exception: connecting alone
        // moves nothing on the card; the address-book COUNT only moves once
        // the import tool actually runs (see contacts_connected below).
        const p = OAUTH_PROVIDERS[provider] || OAUTH_PROVIDERS.google_calendar;
        let result;
        try {
          result = await withTx(pool, (client) => p.flow().completeOAuth(client, {
            state, code: q.get('code'), error: q.get('error'),
          }, googleOpts || {}));
        } catch (e) {
          console.error('[oauth] callback failed:', e);
          result = { ok: false, error: { code: 'internal' } };
        }
        const page = (code, title, body) => {
          res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(oauthResultPage(title, body));
        };
        if (result.ok) {
          if (p.refreshesCard(result.data)) await refreshUserCard(pool, result.data.userId);
          return page(200, ...p.success(result.data));
        }
        const reason = result.error && result.error.reason;
        if (reason === 'declined') return page(200, 'לא חובר', 'ביטלת את החיבור. אפשר לנסות שוב מתי שתרצה.');
        if (reason === 'no_calendar_scope') return page(200, 'חסרה הרשאת יומן', 'במסך של גוגל לא סומנה תיבת הסימון ליד ההרשאה ליומן, אז גוגל לא נתנה גישה ליומן. עולמה תשלח לך קישור חדש בוואטסאפ — הפעם סמני את התיבה של היומן לפני שלוחצים המשך.');
        if (reason === 'no_mail_scope') return page(200, 'חסרה הרשאת מייל', 'במסך של גוגל לא סומנה תיבת הסימון ליד ההרשאה למייל, אז גוגל לא נתנה גישה לתיבה. עולמה תשלח לך קישור חדש בוואטסאפ — הפעם סמני את התיבה של המייל לפני שלוחצים המשך.');
        if (reason === 'no_contacts_scope') return page(200, 'חסרה הרשאת אנשי קשר', 'במסך של גוגל לא סומנה תיבת הסימון ליד ההרשאה לאנשי קשר, אז גוגל לא נתנה גישה. עולמה תשלח לך קישור חדש בוואטסאפ — הפעם סמני את התיבה של אנשי הקשר לפני שלוחצים המשך.');
        if (reason === 'no_scope_granted') return page(200, 'לא חובר כלום', 'במסך של גוגל לא סומנה אף תיבה, אז שום דבר לא חובר. עולמה תשלח לך קישור חדש בוואטסאפ — הפעם סמני את התיבות שרוצים לפני שלוחצים המשך.');
        if (reason === 'bad_state') return page(400, 'הקישור פג', 'קישורי חיבור תקפים ל-15 דקות ולשימוש אחד. בקשי מעולמה קישור חדש.');
        return page(400, 'משהו השתבש', 'החיבור לא הושלם. בקשי מעולמה קישור חדש.');
      }

      // The availability picker — public like the OAuth callback and for the
      // same reason: the person taps it from WhatsApp on their phone, so it
      // cannot sit behind the admin password. The token in the path is the
      // whole credential (random, user-bound, time-limited; picker.js).
      const pick = parsed.pathname.match(picker.TOKEN_RE);
      if (pick) {
        return picker.handle(req, res, pool, pick[1], { calendarDomain });
      }

      // The PERSONAL dashboard — the page a user opens about themselves, as
      // opposed to everything below this line, which is the operator's page
      // about everybody. Ahead of Basic Auth for the same reason as the two
      // routes above it: the person taps it from WhatsApp on their phone and
      // has no admin password. It carries its own identity model (a one-time
      // link exchanged for a session cookie; domain/dashboard-auth.js), and
      // every route inside it refuses without one.
      if (userDashboard.matches(parsed.pathname)) {
        return userDashboard.handle(req, res, pool, parsed.pathname);
      }

      // Unauthenticated READINESS probe, for the deploy gate specifically —
      // "did the release we just restarted come up", nothing more.
      //
      // This exists because /health below cannot answer that question. /health
      // is 503 whenever any sweep is late, and a sweep's lateness is a property
      // of the PREVIOUS process: five seconds after a restart no job has had
      // its first tick, so the heartbeat table still describes the old one.
      // Gating a deploy on it meant that once any slow job fell behind, every
      // deploy failed its check, rolled back, failed the check again (a
      // rollback cannot make a sweep on time either) and reported the rollback
      // itself as broken. Observed 2026-08-22: two consecutive merges to main
      // rolled back this way, and the change that would have fixed the
      // underlying staleness was one of the two things it refused to deploy.
      //
      // brokerd's own heartbeat is the right signal: it is written once
      // immediately at startup and then every 60s, so a fresh, correctly armed
      // daemon has one within seconds, and a daemon that crashed on boot or
      // never reached its timers does not.
      if (req.url === '/ready') {
        try {
          await pool.query('SELECT 1');
          const { rows } = await pool.query(
            `SELECT extract(epoch from now() - last_run_at) AS age
             FROM job_heartbeats WHERE job_name = 'brokerd'`);
          const age = rows[0] ? Number(rows[0].age) : null;
          const ok = age !== null && age < BROKERD_BEAT_MAX_AGE_S;
          res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok, brokerdBeatAgeSeconds: age }));
        } catch (e) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'db unavailable' }));
        }
      }

      // Unauthenticated liveness probe for MONITORING — the process, the DB,
      // whether every sweep is running on its declared cadence, and since
      // 2026-09-03 the GATEWAY. Deploys use /ready above; this one is allowed
      // to go red for reasons a redeploy would not fix, which is the whole
      // point of it — and the gateway is exactly such a reason, which is why
      // it can be added here and could not be added there.
      if (req.url === '/health') {
        // Probed outside the try: a dead DB and a dead gateway are two
        // separate facts, and the endpoint that exists to say which thing
        // broke must not collapse them into one line.
        const gateway = await cachedGateway();
        try {
          await pool.query('SELECT 1');
          const { rows } = await pool.query(`SELECT job_name, last_run_at, note FROM job_heartbeats`);
          const verdict = assessJobs(rows);
          // `unknown` is deliberately not red — see gateway-health.js.
          const ok = verdict.ok && gateway.status !== 'down';
          res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ...verdict, ok, gateway: publicGateway(gateway) }));
        } catch (e) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'db unavailable', gateway: publicGateway(gateway) }));
        }
      }
      // ---- the two pages a stranger on allma.world is allowed to read ----
      //
      // Google's OAuth verification requires a working home page describing
      // what the app does and a reachable privacy policy on the same domain,
      // or the "hasn't verified this app" screen never goes away. Both sit
      // AHEAD of Basic Auth for the same reason /pick/ and the OAuth callback
      // do: the people who need them are not admins.
      //
      // `/` is the load-bearing subtlety. On olmachat.duckdns.org it is the
      // ADMIN DASHBOARD and must stay behind the password, so the public home
      // page is served for the PUBLIC hostnames only and every other host
      // falls straight through to the dashboard exactly as before. Caddy
      // already refuses to route `/` from allma.world to this process at all
      // until its allowlist says so — this check is the second lock, so that
      // a Caddyfile edit alone can never expose the admin root.
      if (req.method === 'GET' && parsed.pathname === '/privacy') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(publicPages.privacyPage());
      }
      if (req.method === 'GET' && parsed.pathname === '/' && PUBLIC_HOSTS.has(hostOf(req))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(publicPages.homePage());
      }

      if (!checkBasicAuth(req, adminUser, adminPass)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="olma2"' });
        return res.end('auth required');
      }
      const url = new URL(req.url, 'http://x');

      if (req.method === 'POST') {
        const body = await readBody(req);
        const cookieCsrf = getCookie(req, 'csrf');
        if (!cookieCsrf || body.csrf !== cookieCsrf) {
          res.writeHead(403); return res.end('csrf');
        }
        let cardUserId = null;
        // Set only by /users/dashboard, which lands on the public host.
        let openUrl = null;
        await withTx(pool, async (client) => {
          if (url.pathname === '/boost') {
            // The dashboard writes the FLAG and never the gateway config —
            // jobs/boost.js is the only writer, so a click cannot leave the
            // config half-changed and a crash here self-heals on the next tick.
            const model = await flagsDomain.getFlag(client, boostJob.MODEL_FLAG);
            if (body.action === 'on') {
              let live = null;
              try { live = boostDomain.currentModel(occ.loadConfig(OPENCLAW_CONFIG_PATH)); } catch { live = null; }
              const r = boostDomain.engageState(live, model, new Date());
              // A refusal changes nothing at all — same rule as a malformed
              // flag value. Better an unchanged switch than a boost with no
              // way back.
              if (r.ok) {
                await flagsDomain.setFlag(client, boostJob.STATE_FLAG, r.state);
                await auditDomain.record(client, null, 'admin.boost_on',
                  { model, restoreTo: r.state.restore.model, until: r.state.until });
              } else {
                await auditDomain.record(client, null, 'admin.boost_refused', { reason: r.error });
              }
            } else if (body.action === 'off') {
              // Off is a flag write too: the reconciler sees an expired state
              // next tick and restores the captured default properly. Clearing
              // the state here without putting the config back would strand
              // everyone on the demo model.
              const cur = await flagsDomain.getFlag(client, boostJob.STATE_FLAG);
              if (boostDomain.isEngaged(cur)) {
                await flagsDomain.setFlag(client, boostJob.STATE_FLAG,
                  { ...cur, until: new Date(Date.now() - 1000).toISOString() });
                await auditDomain.record(client, null, 'admin.boost_off', { model: cur.model });
              }
            }
          } else if (url.pathname === '/flags' && EDITABLE_FLAGS.includes(body.key)) {
            // Coerce by declared type — a stray character must never turn a
            // number into a string and silently change live behaviour.
            const spec = FLAG_SPECS.find((f) => f.key === body.key);
            let val;
            if (spec.type === 'bool') val = body.value === 'true';
            else if (spec.type === 'text') {
              // Free text (model ids, phone lists) — trimmed and bounded, and
              // never coerced: an empty value falls back to the code default.
              val = String(body.value || '').trim().slice(0, 300) || null;
            } else if (spec.type === 'json') {
              // Parsed AND shape-checked before it can land. A flag the page
              // later reads as an object must never be able to hold a string:
              // unparseable or wrong-shaped input changes nothing at all,
              // exactly like the numeric typo rule below.
              try {
                const parsed = JSON.parse(String(body.value || '').trim() || '{}');
                val = (!spec.validate || spec.validate(parsed)) ? parsed : null;
              } catch { val = null; }
            } else {
              val = Number(body.value);
              if (!Number.isFinite(val) || val < 0) val = null;
            }
            if (val !== null) await flagsDomain.setFlag(client, body.key, val);
          } else if (url.pathname === '/issues/status') {
            await issuesDomain.setStatus(client, Number(body.id), body.status);
          } else if (url.pathname === '/users/quota') {
            // A non-numeric override would reach Postgres as NaN and abort the
            // whole transaction with a 500 — an operator typo must simply not
            // change anything.
            const parsed = parseInt(body.override, 10);
            const override = body.override === '' ? null : parsed;
            if (override === null || Number.isFinite(override)) {
              await client.query(`UPDATE users SET quota_override_daily = $2 WHERE id = $1`, [Number(body.id), override]);
            }
          } else if (url.pathname === '/users/delete') {
            // Keyed by phone, not row id: the confirmation page the operator
            // read was about a specific person, and the phone is what the
            // gateway config and workspace are keyed on anyway.
            if (/^\+\d{7,15}$/.test(body.phone || '')) {
              await deprovisionUser(client, body.phone, { configPath });
            }
          } else if (url.pathname === '/users/dashboard') {
            const uid = Number(body.id);
            const made = await dashboardAuth.createLinkUrl(client, uid);
            if (made.ok) {
              await auditDomain.record(client, uid, 'admin.dashboard_opened', {});
              // The only redirect on this page that leaves the host, so it is
              // the only one `safeBack` cannot vet. It is built from the
              // `public_base_url` FLAG rather than from anything in the
              // request — but a flag is admin-editable text, and an open
              // redirect gadget one typo away is not worth the saved line.
              if (/^https?:\/\/[^\s/]+\/d\/[a-f0-9]{64}$/.test(made.data.url)) {
                openUrl = made.data.url;
              }
            }
          } else if (url.pathname === '/users/resume'
                     || url.pathname.startsWith('/outbox/') || url.pathname.startsWith('/prefs/')
                     || url.pathname.startsWith('/facts/')) {
            cardUserId = await handleUserEdit(client, url.pathname, body);
          }
        });
        // The card is rewritten only after the transaction committed — the same
        // rule brokerd follows. A file write inside the transaction would leave
        // USER.md describing a state the database rolled back.
        if (cardUserId) await refreshUserCard(pool, cardUserId);
        res.writeHead(303, { Location: openUrl || safeBack(body.back) });
        return res.end();
      }

      // GET / — render everything; (re)issue the CSRF cookie
      const csrf = getCookie(req, 'csrf') || crypto.randomBytes(16).toString('hex');
      const client = await pool.connect();
      let sectionsHtml = '';
      let healthy = true;
      try {
        const hb = await client.query(`SELECT job_name, last_run_at, note FROM job_heartbeats`);
        // The header dot used to ignore the gateway, so it said "all systems
        // fine" over a health table showing the gateway down; /health had it
        // right. One cached probe serves the header, the strip and the section.
        const gateway = await cachedGateway();
        healthy = assessJobs(hb.rows).ok && gateway.status !== 'down';
        if (url.pathname === '/user') {
          const page = await renderUserPage(client, parseInt(url.searchParams.get('id'), 10) || 0, {
            confirmDelete: url.searchParams.get('confirm') === 'delete', csrf,
          });
          sectionsHtml = page || '<section><h3>משתמש לא נמצא</h3><p class="hint"><a href="/">חזרה</a></p></section>';
        } else if (url.pathname === '/contacts') {
          // Its own page, not a section: an address book runs to thousands of
          // rows, which is the one thing the single-page layout cannot hold.
          sectionsHtml = await renderContactsPage(client, {
            q: url.searchParams.get('q') || '',
            onlyOlma: url.searchParams.get('only') === 'olma',
            page: Math.max(0, parseInt(url.searchParams.get('page'), 10) || 0),
          });
        } else {
          const alerts = renderAlerts(await collectAlerts(client, { hbRows: hb.rows, gateway }));
          for (const g of GROUPS) {
            let inner = g.id === 'now' ? alerts : '';
            for (const s of SECTIONS.filter((x) => x.group === g.id)) {
              inner += `<section id="${s.id}"><h3>${s.title}</h3>` +
                `<p class="hint">${s.hint}</p>${await s.render(client, csrf, cachedGateway, { configPath })}</section>`;
            }
            sectionsHtml += `<details class="group" id="g-${g.id}"${g.open ? ' open' : ''}><summary>${g.title}</summary>${inner}</details>`;
          }
        }
      } finally { client.release(); }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // every number on this page is live state; a cached copy is always a lie
        // (and a stale copy after a deploy reads as "the change didn't ship")
        'Cache-Control': 'no-store, must-revalidate',
        'Set-Cookie': `csrf=${csrf}; SameSite=Strict; Path=/; HttpOnly`,
      });
      res.end(`<!doctype html><html lang="he"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <meta name="color-scheme" content="dark light">
        <title>עולמה — לוח בקרה</title>${STYLE}</head>
        <body><header>
          <div class="brand"><span class="dot ${healthy ? '' : 'bad'}"></span>
            <h1>עולמה — לוח בקרה</h1>
            <span class="dim small">${healthy ? 'כל המערכות תקינות' : 'יש תקלה — ראה מצב המערכת'}</span>
          </div>
          <nav>${GROUPS.map((g) => `<a href="${url.pathname === '/' ? '' : '/'}#g-${g.id}">${g.title}</a>`).join('')}</nav>
        </header>
        <main>${sectionsHtml}</main></body></html>`);
    } catch (e) {
      console.error('[dashboard]', e);
      res.writeHead(500); res.end('error');
    }
  });
  return server;
}

module.exports = { createDashboard, checkBasicAuth, SECTIONS, EDITABLE_FLAGS };

