'use strict';
// The brokerd core: a unix-socket server dispatching tool calls into the
// domain, one transaction per call, over a shared pg pool. Line-delimited
// JSON: {id, method, params} → {id, ok, ...}.
//
// This process outliving turns is the point: connection pool (managed
// Postgres allows ~22 connections — a pool of 10 serves hundreds of users),
// in-memory flood counters, and (Phase D) the outbox worker.
const net = require('node:net');
const fs = require('node:fs');
const { withTx } = require('../db/pool');
const usersDomain = require('../domain/users');
const { BY_NAME, audienceOf } = require('../adapters/mcp/registry');
const { renderResult } = require('../adapters/mcp/render');
const { readIdentity, stripIdentity } = require('../adapters/mcp/identity-param');
const { FloodCounter } = require('./flood');
const { refreshUserCard, CARD_TOOLS } = require('../intake/user-card');
const turnDomain = require('../domain/turn');
const reactions = require('../domain/reactions');
const reminders = require('../domain/reminders');
const chaseDeadline = require('../domain/chase-deadline');
const selfInitiated = require('../domain/self-initiated');
const { captureDisplayName } = require('../adapters/mcp/tools/_shared');
const groupContext = require('../domain/group-context');
const groupsDomain = require('../domain/groups');
const groupTurn = require('../domain/group-turn');
const intakeRoom = require('../domain/intake-room');
const onboardingDomain = require('../domain/onboarding');
const audit = require('../domain/audit');
const gameSummary = require('../domain/game-summary');
const replyLeak = require('../domain/reply-leak');
const phantomSave = require('../domain/phantom-save');
const markEcho = require('../domain/mark-echo');
const linkRequest = require('../domain/link-request');
const dashboardAuth = require('../domain/dashboard-auth');
const templates = require('../domain/message-templates');
const gameShortcut = require('../domain/game-shortcut');
const packsDomain = require('../domain/packs');
const { timezoneForPhone } = require('../domain/phone-timezone');

// One of these per turn. The gateway spawns a fresh MCP shim for every agent
// turn and the shim holds ONE socket to brokerd for its whole life, so a
// connection IS a turn — no new protocol field, no clock heuristic. A shim
// that reconnects mid-turn (only after a socket error) starts a new one; the
// cost of that rare case is one extra counted message, against the current
// cost of a whole turn going uncounted.
//
// That mapping is true of the gateway TODAY, and bin/olma-mcp.js already
// refuses to bet on it staying true (its identity self-healing says so in
// as many words). So neither does this: `userId` below makes a connection
// that ever serves a second user start a fresh turn, and the recovery's
// count is consumed exactly once. Both mean that if the process model
// changes underneath us, the failure is "no recovery" — today's behaviour —
// rather than a message silently going uncounted for someone else.
const newTurn = () => ({
  userId: null, opened: false, counted: false, quota: null,
  // The inbound message id the acknowledgement marks attach to, and when it
  // arrived. Per-turn and never persisted: a mark belongs on the message being
  // handled right now, and a stale id would put one on the wrong message.
  messageId: null, lastInboundAt: null,
  // What has already been asked for on this turn, so a model that calls
  // `turn_start` twice does not buy a second identical reaction. Populated
  // lazily by markFor, which is the only thing that reads it.
  marked: null,
});

// A turn the gateway opened for a user BEFORE the model's first tool call
// (method `turn_open`, sent by gateway-hooks/olma-turn-open on every accepted
// inbound message). Held here until the shim connection for that user makes
// its first call and adopts it — no second count, and every mark lands on
// the real message id. Bounded by age: a pending open the model never
// followed (a message it answered with no tool at all) is dropped after
// PENDING_TTL_MS so it cannot be adopted by tomorrow's turn.
//
// A QUEUE per user, oldest first, since 2026-09-06 — it was one slot, and
// Miron's "בוצע" followed three seconds later by "עוד לא" showed what a slot
// does: the second open overwrote the first, so the first turn's tools would
// have adopted the second message's open (its marks on the wrong message,
// and under the gateway's follow-up queue mode the first message's open
// simply gone). Now each message keeps its own entry; which one a turn
// adopts is decided below (takePending / peekPending), and the queue is
// capped so a person who writes ten lines while the model thinks cannot
// grow it without bound.
const PENDING_TTL_MS = 10 * 60_000;
const PENDING_MAX_PER_USER = 8;

// `lidPhoneNumbers` is injectable for one reason: the default reaches the
// gateway's credentials directory, and a test file must never reach the LIVE
// gateway — not its home and not its roster. The suite passes its own map;
// production gets the worker facade, never `channels/sessions.js` directly,
// because every export there is synchronous and this daemon answers live
// users on the same loop.
function createBrokerServer({ pool, flood, placeMark, now, lidPhoneNumbers, timers, endSignalsLive, games, readGreeterReply }) {
  flood = flood || new FloodCounter();
  // gamesd and the gateway's config, for the game shortcut. Injectable for the
  // same reason as the roster: the defaults reach live services.
  games = {
    open: (b) => require('../channels/gamesd').open(b),
    join: (b) => require('../channels/gamesd').join(b),
    applyPolicy: (agentId, packs) => packsDomain.applyPolicy(agentId, packs),
    ...(games || {}),
  };
  const readLidPhones = typeof lidPhoneNumbers === 'function'
    ? lidPhoneNumbers
    : () => require('../channels/sessions-async').lidPhoneNumbers();
  // The greeter's newest reply to a number, off the gateway's session store —
  // for the game shortcut, which must not introduce somebody the greeter just
  // did. Injectable like the roster; unreadable is null, which is the old
  // behaviour.
  const readGreeterSaid = typeof readGreeterReply === 'function'
    ? readGreeterReply
    : async (phone) => {
      const msgs = await require('../channels/sessions-async').readRecentMessages('intake', 10, undefined, phone);
      const last = [...msgs].reverse().find((m) => m.role === 'assistant');
      return last ? last.text : null;
    };
  const clock = typeof now === 'function' ? now : Date.now;
  // userId → [{ messageId, kind, senderName, replyToId, lastInboundAt, counted, quota, firstTurn, openedAt, contextSent }], oldest first
  const pending = new Map();
  function livePending(userId) {
    const list = (pending.get(userId) || []).filter((p) => clock() - p.openedAt <= PENDING_TTL_MS);
    if (list.length) pending.set(userId, list); else pending.delete(userId);
    return list;
  }
  function pushPending(userId, entry) {
    const list = livePending(userId);
    list.push(entry);
    while (list.length > PENDING_MAX_PER_USER) list.shift();
    pending.set(userId, list);
  }
  // Messages code already answered before any turn existed (the link shortcut
  // below): messageId → when. The turn-open hook runs fire-and-forget and can
  // land either side of that answer, so both orders are handled — an open
  // already queued is dropped, and one arriving later marks 👍 and queues
  // nothing, because no turn is coming to adopt it.
  const answeredByCode = new Map();
  function noteAnsweredByCode(userId, messageId) {
    const at = clock();
    for (const [id, t] of answeredByCode) if (at - t > PENDING_TTL_MS) answeredByCode.delete(id);
    answeredByCode.set(messageId, at);
    const list = livePending(userId).filter((p) => p.messageId !== messageId);
    if (list.length) pending.set(userId, list); else pending.delete(userId);
  }
  // The shim connection's first tool call adopts an open. Which one: the
  // oldest whose opening was already put in the prompt (`contextSent`) —
  // that is the turn now running, and a later message that arrived while it
  // ran must not be stolen from its own turn. With no such entry (the turn
  // opens with turn_start, or the plugin never asked) it is the newest, and
  // the older ones are dropped with it: they belong to turns that ended with
  // no tool call at all, and adopting one of those would put this turn's
  // marks on an earlier message — exactly the one-slot bug, one step behind.
  function takePending(userId) {
    const list = livePending(userId);
    if (!list.length) return null;
    const idx = list.findIndex((p) => p.contextSent);
    let taken;
    if (idx >= 0) { taken = list[idx]; list.splice(idx, 1); }
    else { taken = list[list.length - 1]; list.length = 0; }
    if (list.length) pending.set(userId, list); else pending.delete(userId);
    return taken;
  }
  // Read without adopting: `turn_context` needs the open but must leave it
  // for the shim connection, which is what puts the 👍 on the right message.
  // The oldest entry not yet put in a prompt is this prompt's message; every
  // entry older than it was already contexted for a turn that has since
  // ended (the gateway runs one turn per session at a time) and is dropped
  // here, so a turn that made no tool call leaves nothing behind for the
  // next one to adopt by mistake. A rebuilt prompt for the same message
  // (every entry already contexted) reads the newest again, and the
  // `contextSent` flag on it keeps the first-turn stamp from being spent
  // twice.
  function peekPending(userId) {
    const list = livePending(userId);
    if (!list.length) return null;
    const idx = list.findIndex((p) => !p.contextSent);
    if (idx < 0) return list[list.length - 1];
    if (idx > 0) { list.splice(0, idx); pending.set(userId, list); }
    return list[0];
  }
  // What `reply_claim` judges a reply by (domain/phantom-save.js): when this
  // person's recent turns opened, and when a tool last ran for them. In
  // process on purpose — it is only ever asked about a turn still running —
  // and a restart that loses it answers `unknown`, never `unbacked`.
  const claimOpens = new Map();
  const lastToolAt = new Map();
  // …and when one last FAILED, so a claim on a turn whose own write was refused
  // reads `failed` rather than borrowing an earlier turn's success.
  const lastFailAt = new Map();
  // What the tool that earned this turn's 👍 wrote — its title, its name —
  // for the reply gate's echo check (domain/mark-echo.js). Set only where
  // `hints.markPlaced` is set, and forgotten by anything that could make a
  // following sentence worth saying: a new message, a tool that earned no 👍,
  // a failure. In process, like the claim memory above, so a restart forgets
  // it and the gate passes — the old behaviour, never a dropped answer.
  const markEchoes = new Map();
  const MARK_ECHO_MS = 5 * 60 * 1000;
  function noteOpen(userId) {
    markEchoes.delete(userId);
    const at = clock();
    const list = (claimOpens.get(userId) || []).filter((t) => at - t <= phantomSave.OPEN_WINDOW_MS);
    list.push(at);
    while (list.length > PENDING_MAX_PER_USER) list.shift();
    claimOpens.set(userId, list);
  }

  // ── The 👀 that waits (domain/reactions.openingDelayMs) ─────────────────────
  // agentId → [{ messageId, timer, running, openedAt }], oldest first: one
  // entry per message whose opening mark is due or whose turn has not ended.
  // The gateway runs one turn per person at a time (`messages.queue.mode`
  // followup), so the entry whose prompt was built last (`running`) is the
  // turn that a "reply" or "end" signal from the plugin is about. A message
  // that arrived while another turn ran keeps its own timer: it IS waiting.
  // A turn Olma started never marks anything running (`handleTurnContext`
  // peeks no open for it), so its reply cancels nobody's 👀.
  const setTimer = (timers && timers.set) || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
  const clearTimer = (timers && timers.clear) || clearTimeout;
  const signalsLive = typeof endSignalsLive === 'function' ? endSignalsLive : () => reactions.endSignalsLive({ now: clock() });
  const pendingEyes = new Map();
  function eyesOf(agentId) {
    const list = (pendingEyes.get(agentId) || []).filter((e) => clock() - e.openedAt <= reactions.LIVE_WINDOW_MS || e.timer);
    if (list.length) pendingEyes.set(agentId, list); else pendingEyes.delete(agentId);
    return list;
  }
  function holdEyes(agentId, mark, delayMs) {
    const list = eyesOf(agentId);
    const entry = { messageId: mark.messageId, running: false, openedAt: clock(), timer: null };
    entry.timer = setTimer(() => { entry.timer = null; placeMark(mark); }, delayMs);
    list.push(entry);
    pendingEyes.set(agentId, list);
  }
  function stopEyes(entry) {
    if (entry && entry.timer) { clearTimer(entry.timer); entry.timer = null; }
  }
  // Its prompt is being built: this message's turn has started, so every older
  // entry's turn is over whether or not its end was heard.
  function eyesRunning(agentId, messageId) {
    const list = eyesOf(agentId);
    const idx = list.findIndex((e) => e.messageId === messageId);
    if (idx < 0) return;
    for (const old of list.splice(0, idx)) stopEyes(old);
    list[0].running = true;
    pendingEyes.set(agentId, list);
  }
  // A closing mark on the message says more than the 👀 would have.
  function eyesAnswered(messageId) {
    for (const list of pendingEyes.values()) for (const e of list) if (e.messageId === messageId) stopEyes(e);
  }

  // When Olma's latest reply to a person ENDED on a question (the plugin's
  // `turn_progress reply` says so, a boolean and never the words). A bare
  // thanks inside reactions.THANKS_AFTER_QUESTION_MS of it is their answer.
  // In memory, so a brokerd restart forgets it and that thanks closes the
  // exchange as before — the old behaviour, never a wrong one.
  const askedAt = new Map();
  function askedRecently(agentId) {
    const at = askedAt.get(agentId);
    return at != null && clock() - at <= reactions.THANKS_AFTER_QUESTION_MS;
  }

  // Injectable for the same reason `send` is everywhere else here: the test
  // that matters for this feature is the one that watches a real turn place a
  // real mark, and it must do that without spawning anything.
  placeMark = placeMark || reactions.placeMark;

  // The gateway's opener. The agent id is the only identity the hook has, and
  // it is enough: one agent, one active user (config_guard keeps it so).
  // Eleven of the first ~200 opens the gateway hook sent timed out on ITS side
  // (2s) and left nothing here — no audit row, no journal line, no crash — so
  // whether brokerd was slow, blocked or never reached could not be told
  // apart. `tool_call` above logs its failures; this path did not. Now it
  // does, and it logs where the time went whenever it takes longer than the
  // hook is willing to wait for half of it. A quiet failure is not a passing
  // one (CLAUDE.md, "a check that goes quiet").
  const TURN_OPEN_SLOW_MS = 1000;
  async function handleTurnOpen(params = {}) {
    const agentId = String(params.agentId || '').trim();
    if (agentId === 'intake') return handleIntakeGameShortcut(params);
    if (!/^u-\d+$/.test(agentId)) return { ok: false, error: 'bad agentId' };
    const started = Date.now();
    const steps = [];
    const lap = (name) => steps.push(`${name}=${Date.now() - started}`);
    try {
      const out = await openTurnFromGateway(agentId, params, lap);
      const ms = Date.now() - started;
      if (ms >= TURN_OPEN_SLOW_MS) console.error(`[brokerd] turn_open ${agentId} slow: ${ms}ms (${steps.join(' ')})`);
      return out;
    } catch (e) {
      console.error(`[brokerd] turn_open ${agentId} failed after ${Date.now() - started}ms (${steps.join(' ')}):`, e);
      return { ok: false, error: 'turn_open failed' };
    }
  }

  async function openTurnFromGateway(agentId, params, lap) {
    const messageId = reactions.cleanMessageId(params.messageId);
    const kind = params.kind === 'voice' ? 'voice' : 'text';
    let out = null;
    let mark = null;
    let delayMs = 0;
    await withTx(pool, async (client) => {
      lap('tx');
      const { rows } = await client.query(
        `SELECT id, phone, timezone FROM users WHERE agent_id = $1 AND status = 'active'`, [agentId]);
      lap('user');
      const user = rows[0];
      if (!user) { out = { ok: false, error: 'no active user for agent' }; return; }
      const rec = await turnDomain.openFromGateway(client, user, { messageId, kind, now: clock() });
      lap('open');
      // The hook classified the text and sent us the verdict, never the words
      // (gateway-hooks/olma-turn-open). A message that is only thanks gets 🙏
      // instead of 👀: 👀 promises a reply and this one is not getting one.
      // …unless the last thing Olma said to them was a question: then the
      // thanks is their answer (most likely a yes), it gets the ordinary 👀,
      // and the model is told to read it as one. Spent on use.
      const saidThanks = params.thanks === true;
      const thanksAfterQuestion = saidThanks && !rec.skipped && askedRecently(agentId);
      const thanksOnly = saidThanks && !thanksAfterQuestion;
      if (thanksAfterQuestion) {
        askedAt.delete(agentId);
        await audit.record(client, user.id, 'turn.thanks_after_question', { messageId });
      }
      // "להפסיק להזכיר" is answered by a WRITE, here, before the model reads
      // the turn — every ladder that has actually spoken to them in the last
      // day stops (domain/reminders.stopRecentLadders), and the mark on the
      // message becomes 👍: 👀 promises a reply, and the fact is already
      // carried. Nothing is stopped when nothing was chasing, and then this is
      // an ordinary turn about the word "תזכורות".
      const stopped = !rec.skipped && params.stopReminders === true
        ? await reminders.stopRecentLadders(client, user.id, { now: new Date(clock()) })
        : null;
      const stoppedReminders = stopped ? stopped.stopped.length : 0;
      if (stopped) lap('stop');
      const byCode = Boolean(messageId && answeredByCode.has(messageId));
      const state = stoppedReminders || byCode ? 'done'
        : thanksOnly ? 'thanks' : (kind === 'voice' ? 'listening' : 'working');
      const entry = {
        messageId, kind, lastInboundAt: clock(), openedAt: clock(),
        // The WhatsApp display name, kept for `turn_context` below: on the
        // turn_start path the model relays it as sender_name; here the hook
        // already saw it, so the person whose prompt opens the turn is named
        // by the same rule (a guess they still confirm, never an overwrite).
        senderName: typeof params.senderName === 'string' ? params.senderName.slice(0, 80) : null,
        // The message they replied to, when the hook saw a WhatsApp reply.
        // Only `turn_context` reads it (the plugin cannot see the reply from
        // where it stands — see the hook); on the turn_start path the model
        // relays `reply_to_id` itself, as before.
        replyToId: reactions.cleanMessageId(params.replyToId) || null,
        counted: rec.counted, quota: rec.quota, firstTurn: Boolean(rec.firstTurn),
        thanksOnly, thanksAfterQuestion, stoppedReminders,
        // "help me until next week": the hook's verdict, resolved here against
        // THEIR clock at the moment the message arrived, and armed by add_task
        // or set_task_reminder on this turn (domain/chase-deadline). Nothing is
        // written now — there is no task yet to chase.
        chase: rec.skipped ? null : chaseDeadline.forTurn(params.chase, { now: new Date(clock()), timezone: user.timezone }),
        // "מה פתוח לי?": the turn is told about their list, not their day —
        // domain/turn.advise leaves the today block out (see the hook).
        openList: !rec.skipped && params.openList === true,
        // "תזכיר לי X" with no when at all: the moment it was HEARD, so the
        // add_task this turn makes arms a weekly nudge on it
        // (reminders.startWeeklyNudge) — and only inside the same window a
        // chase gets, never on a turn that runs on long after the message.
        remindAsk: !rec.skipped && params.remindAsk === true ? clock() : null,
        marked: new Set(), contextSent: false,
      };
      if (!rec.skipped && messageId) {
        // The 👀 (or 👂) is decided here, before any model latency — and held
        // for `eyes_delay_seconds` when the plugin can tell us the answer went
        // out first (domain/reactions.openingDelayMs): a message answered
        // inside that needs no "I'm on it". 🙏 and the stop-reminders 👍 are
        // the answer and go on at once.
        const flags = require('../domain/flags');
        const vocab = reactions.vocabulary(await flags.getFlag(client, reactions.VOCAB_FLAG));
        delayMs = reactions.openingDelayMs(state, await flags.getFlag(client, reactions.EYES_DELAY_FLAG), signalsLive());
        lap('vocab');
        mark = { channel: 'whatsapp', target: user.phone, messageId, state, emoji: vocab[state] };
        entry.marked.add(`${messageId}:${state}`);
        entry.reactionVocab = vocab;
      }
      if (!rec.skipped && !byCode) { pushPending(Number(user.id), entry); noteOpen(Number(user.id)); }
      out = { ok: true, opened: !rec.skipped, skipped: rec.skipped || null, userId: Number(user.id), counted: rec.counted };
    });
    lap('commit');
    if (mark && delayMs > 0) holdEyes(agentId, mark, delayMs);
    else if (mark) placeMark(mark);
    return out;
  }

  // Game nights from a private chat (domain/game-shortcut.js has the why):
  // "ערב משחק חדש", the price that answers it, a night's join code, and the
  // name that answers "איך קוראים לך?". Asked FIRST by the link shortcut, on
  // the same short DMs, and answers null for everything that is not one of
  // them — which is nearly every message, so the common path is three pure
  // matches and one Map read.
  //
  // What she just asked is held here, in memory, per agent, for a quarter of
  // an hour, and the NEXT short message ends it whatever it says: an answer
  // that is not a price or a name goes to the model, and nothing is read as
  // an answer to a question two messages back. A restart forgets the
  // question, and the answer then goes to the model, which by then has the
  // pack's tools — the old path, never a wrong one.
  //
  // Somebody new is asked before they have an agent, so that question is kept
  // under `tel:<phone>` — and the intake sweep may give them one before they
  // answer, so their own agent's path looks there too (`phoneAsk`).
  const GAME_ASK_TTL_MS = 15 * 60_000;
  const gameAsked = new Map();   // agentId | tel:<phone> → { kind: 'setup' | 'name', code?, lang?, at }
  function takeGameAsk(agentId) {
    const a = gameAsked.get(agentId);
    gameAsked.delete(agentId);
    return a && clock() - a.at <= GAME_ASK_TTL_MS ? a : null;
  }
  const askGame = (agentId, ask) => gameAsked.set(agentId, { ...ask, at: clock() });
  async function phoneAsk(agentId) {
    if (![...gameAsked.keys()].some((k) => k.startsWith('tel:'))) return null;
    const { rows } = await pool.query('SELECT phone FROM users WHERE agent_id = $1', [agentId]);
    return rows[0] ? takeGameAsk(`tel:${rows[0].phone}`) : null;
  }
  // The name they gave for the night is their name (owner, 2026-10-01): said
  // by them, so confirmed — but never over a name they had already confirmed.
  async function saveGivenName(client, user, name) {
    if (!name || user.name_confirmed) return;
    const [first, ...rest] = name.split(/\s+/);
    await usersDomain.setName(client, user.id, first, rest.join(' ') || null, { confirmed: true, source: 'game_night' });
  }

  async function handleGameShortcut(agentId, params) {
    const body = String(params.body || '');
    const phrase = gameShortcut.matchOpenPhrase(body);
    const code = phrase ? null : gameShortcut.findCode(body);
    const ask = takeGameAsk(agentId) || (!phrase && !code ? await phoneAsk(agentId) : null);
    const setup = !phrase && !code && ask && ask.kind === 'setup' ? gameShortcut.parseSetup(body) : null;
    const name = !phrase && !code && ask && ask.kind === 'name' ? gameShortcut.parseName(body) : null;
    if (!phrase && !code && !setup && !name) return null;

    const { rows } = await pool.query(
      `SELECT id, phone, locale, first_name, last_name, name_confirmed FROM users
        WHERE agent_id = $1 AND status = 'active' AND is_eval = false`, [agentId]);
    const user = rows[0];
    if (!user) return null;
    const userId = Number(user.id);
    // The language on FILE, like the code shortcut: a Hebrew speaker tapping
    // a forwarded "game K7M2Q" still reads Hebrew, and the reply gate drops
    // an English line for them.
    const lang = String(user.locale || (phrase || code || {}).lang || 'he').toLowerCase().startsWith('en') ? 'en' : 'he';
    const overrides = await templates.load(pool);
    const say = (base, vars) => templates.render(templates.keyFor(base, lang, { fallback: 'he' }), vars, overrides);
    const nightVars = (n) => ({ night: n.name, price: gameShortcut.fmtNumber(n.price), chips: gameShortcut.fmtNumber(n.chips), code: n.code });

    let text = null;
    let outcome = null;
    let packVia = null;      // 'phrase' | 'code' when this message turns the pack on
    let invite = null;       // { code, texts } for the host, after the night opens
    let givenName = null;    // the name they answered with, once it seated them
    try {
      if (phrase) {
        const r = await games.open({ userId, probe: true });
        packVia = 'phrase';
        if (r && r.ok && r.already) {
          outcome = 'already_open';
          text = say('game_already_open', { ...nightVars(r.night), url: r.url });
        } else if (r && r.ok && r.none) {
          outcome = 'asked_setup';
          askGame(agentId, { kind: 'setup' });
          text = say('game_open', {});
        } else return null;
      } else if (setup) {
        const nightName = lang === 'en' ? 'Game night' : 'ערב משחק';
        const r = await games.open({
          userId, name: gameShortcut.namesFor(user)[0] || null, locale: lang,
          price: setup.price, chips: setup.chips, nightName,
        });
        if (!r || !r.ok || !(r.opened || r.already) || !r.night) return null;
        packVia = 'phrase';
        outcome = r.opened ? 'opened' : 'already_open';
        const vars = { ...nightVars(r.night), url: r.url };
        text = say(r.opened ? 'game_opened' : 'game_already_open', vars);
        if (r.opened) {
          // Both languages now, the reader's chosen at delivery — the host may
          // forward it anywhere, but it goes out in the host's language.
          // The short link is the same host's /g/<code>, which gamesd answers
          // with a wa.me redirect holding "משחק <code>" — somebody who has
          // never written to her opens a chat that already says it.
          const page = String(r.url).split('#')[0];
          const join = `${new URL(page).origin}/g/${r.night.code}`;
          const inv = { ...vars, url: page, join };
          invite = {
            code: r.night.code,
            texts: {
              he: templates.render('game_invite', inv, overrides),
              en: templates.render('game_invite_en', inv, overrides),
            },
          };
        }
      } else {
        const joinCode = code ? code.code : ask.code;
        const names = name ? [name] : gameShortcut.namesFor(user);
        const r = await games.join({ userId, code: joinCode, names });
        if (!r) return null;
        outcome = r.ok ? (r.joined ? 'joined' : 'already') : r.error;
        if (r.ok) {
          if (!r.night) return null;
          packVia = 'code';
          if (name && r.joined) givenName = r.name;
          const vars = { ...nightVars(r.night), name: r.name, url: r.url };
          text = r.joined || !(r.buyins > 0)
            ? say('game_joined', vars)
            : say('game_already', { ...vars, count: gameShortcut.buyinsText(r.buyins, lang) });
        } else if (r.error === 'need_name') {
          askGame(agentId, { kind: 'name', code: joinCode });
          text = say('game_ask_name', nightVars(r.night));
        } else if (r.error === 'name_taken') {
          askGame(agentId, { kind: 'name', code: joinCode });
          text = say('game_name_taken', { name: r.name });
        } else if (r.error === 'full') {
          text = say('game_full', nightVars(r.night || {}));
        } else if (r.error === 'no_night' && code && code.withWord) {
          text = say('game_no_night', { code: joinCode });
        } else return null;   // a bare five letters that is no night: not ours
      }
    } catch (e) {
      // gamesd down or slow: the model runs, as it did before this existed.
      console.error('[brokerd] game shortcut:', e && e.message || e);
      return null;
    }

    const messageId = reactions.cleanMessageId(params.messageId);
    let mark = null;
    let packs = null;
    await withTx(pool, async (client) => {
      if (packVia) packs = (await packsDomain.enable(client, userId, 'games', packVia)).packs;
      await saveGivenName(client, user, givenName);
      if (invite) await gameSummary.queueInvite(client, { userId, ...invite }, { now: new Date(clock()) });
      await audit.record(client, userId, phrase || setup ? 'games.phrase_shortcut' : 'games.join_shortcut', { outcome, lang });
      if (messageId) {
        const vocab = reactions.vocabulary(await require('../domain/flags').getFlag(client, reactions.VOCAB_FLAG));
        mark = { channel: 'whatsapp', target: user.phone, messageId, state: 'done', emoji: vocab.done };
      }
    });
    // After the row, never before: the row is the permission, the deny list
    // only what the model is shown, and the deploy's sync writes the same
    // list if this does not (domain/packs.js).
    if (packs) {
      try { games.applyPolicy(agentId, packs); } catch (e) {
        console.error('[brokerd] game shortcut: tool policy not written:', e && e.message || e);
      }
    }
    if (messageId) { noteAnsweredByCode(userId, messageId); eyesAnswered(messageId); }
    if (mark) placeMark(mark);
    return { ok: true, claim: true, text, lang, kind: 'game' };
  }

  // Stage 4ב: somebody who has never written to her, arriving by the invite's
  // short link (`allma.world/g/<code>` → wa.me with "משחק <code>" typed in).
  // Their message reaches the intake greeter's session, and the plugin sends
  // it here first, as `agentId: 'intake'` with the session key.
  //
  // What she does is exactly what she does for somebody on Olma already —
  // seat them, or ask their name, or say the night is full or not there —
  // with ONE sentence above it saying who she is and ONE below it saying what
  // she keeps, both once per person ever: whoever says the introduction
  // stamps `opening_sent_at`, and a row that already carries it hears neither.
  // Then the intake sweep makes them a user within seconds, on the same one
  // config write as anybody else (jobs/intake.js, `gameClaimed`), with the
  // pack's tools already on it.
  //
  // It claims nothing it would not have answered for a user: registration
  // closed, the hourly cap, a blocked or eval number, a bare five letters
  // that is no night — each goes to the greeter exactly as before.
  const NOT_OURS = Object.freeze({ ok: true, claim: false });
  async function handleIntakeGameShortcut(params) {
    const phone = intakeRoom.peerOf(params.sessionKey);
    if (!phone) return NOT_OURS;
    const askKey = `tel:${phone}`;
    const body = String(params.body || '');
    const code = gameShortcut.findCode(body);
    // The common path: a stranger saying anything else. No database.
    if (!code && !gameAsked.has(askKey)) return NOT_OURS;

    const existing = await usersDomain.getByPhone(pool, phone);
    if (existing && existing.status === 'active' && existing.agent_id) {
      // Made a user between her question and their answer, with the binding
      // not live yet: their own agent's path, which finds the question by
      // phone.
      if (existing.is_eval) return NOT_OURS;
      return (await handleGameShortcut(existing.agent_id, params)) || NOT_OURS;
    }
    const ask = takeGameAsk(askKey);
    const name = !code && ask && ask.kind === 'name' ? gameShortcut.parseName(body) : null;
    if (!code && !name) return NOT_OURS;
    if (existing && (existing.status !== 'pending' || existing.is_eval)) return NOT_OURS;

    const flags = require('../domain/flags');
    if ((await flags.getFlag(pool, 'registration_open')) !== true) return NOT_OURS;
    const cap = Number(await flags.getFlag(pool, 'intake_hourly_cap') ?? 30);
    const { rows: [{ n: claimsThisHour }] } = await pool.query(
      `SELECT count(DISTINCT actor_id)::int AS n FROM audit_log
        WHERE event = 'games.intake_claim' AND created_at > now() - interval '1 hour'
          AND actor_id IS DISTINCT FROM $1`, [existing ? existing.id : null]);
    if (claimsThisHour >= cap) return NOT_OURS;
    // The privacy link reaches each person ONCE, ever (owner, 2026-10-01). The
    // greeter may have introduced them minutes ago, before any row said so —
    // a code sent before the sweep provisioned them — and then the hello and
    // the privacy line below would be the second time.
    let greeterIntroduced = false;
    if (!existing || (!existing.opening_sent_at && !existing.privacy_link_sent_at)) {
      let said = null;
      try { said = await readGreeterSaid(phone); } catch { said = null; }
      greeterIntroduced = onboardingDomain.carriesPrivacyLink(said);
    }

    const lang = String((code ? code.lang : ask.lang) || 'he').startsWith('en') ? 'en' : 'he';
    const joinCode = code ? code.code : ask.code;
    const overrides = await templates.load(pool);
    const say = (base, vars) => templates.render(templates.keyFor(base, lang, { fallback: 'he' }), vars, overrides);
    const nightVars = (n) => ({ night: n.name, price: gameShortcut.fmtNumber(n.price), chips: gameShortcut.fmtNumber(n.chips), code: n.code });
    const messageId = reactions.cleanMessageId(params.messageId);
    const ROLLBACK = new Error('not ours');

    let out = NOT_OURS;
    let userId = null;
    try {
      await withTx(pool, async (client) => {
        let user = existing;
        if (!user) {
          const made = await usersDomain.createUser(client, {
            phone, locale: lang, timezone: timezoneForPhone(phone), status: 'pending',
            audit: { event: 'user.pending_from_game', detail: { code: joinCode } },
          });
          if (!made.ok) throw ROLLBACK;
          user = made.data.user;
        }
        userId = Number(user.id);
        const names = name ? [name] : (user.name_confirmed ? gameShortcut.namesFor(user) : []);
        // A row that may yet be rolled back is fine to seat under: ids come
        // from a sequence, and a rolled-back one is never handed out again.
        const r = await games.join({ userId, code: joinCode, names });
        if (!r) throw ROLLBACK;
        const outcome = r.ok ? (r.joined ? 'joined' : 'already') : r.error;
        let text;
        if (r.ok) {
          if (!r.night) throw ROLLBACK;
          const vars = { ...nightVars(r.night), name: r.name, url: r.url };
          text = r.joined || !(r.buyins > 0)
            ? say('game_joined', vars)
            : say('game_already', { ...vars, count: gameShortcut.buyinsText(r.buyins, lang) });
          await packsDomain.enable(client, userId, 'games', 'code');
          await saveGivenName(client, user, r.joined ? r.name : null);
        } else if (r.error === 'need_name') {
          askGame(askKey, { kind: 'name', code: joinCode, lang });
          text = say('game_ask_name', nightVars(r.night));
        } else if (r.error === 'name_taken') {
          askGame(askKey, { kind: 'name', code: joinCode, lang });
          text = say('game_name_taken', { name: r.name });
        } else if (r.error === 'full') {
          text = say('game_full', nightVars(r.night || {}));
        } else if (r.error === 'no_night' && code && code.withWord) {
          text = say('game_no_night', { code: joinCode });
        } else throw ROLLBACK;   // a bare five letters that is no night: not ours

        // Stamped whenever they had no opening on record, introduced here or
        // by the greeter: `gameClaimed` provisions off opening_sent_at.
        const introduced = !user.opening_sent_at && !user.privacy_link_sent_at && !greeterIntroduced;
        if (introduced) text = [say('game_hello', {}), text, say('game_privacy', {})].join('\n');
        if (!user.opening_sent_at) {
          await client.query(
            `UPDATE users SET opening_sent_at = COALESCE(opening_sent_at, now()),
                    privacy_link_sent_at = COALESCE(privacy_link_sent_at, now())
              WHERE id = $1 AND opening_sent_at IS NULL`, [userId]);
        }
        await audit.record(client, userId, 'games.intake_claim', { outcome, lang, introduced });
        out = { ok: true, claim: true, text, lang, kind: 'game' };
      });
    } catch (e) {
      if (e !== ROLLBACK) console.error('[brokerd] intake game shortcut:', e && e.message || e);
      return NOT_OURS;
    }
    if (messageId) {
      noteAnsweredByCode(userId, messageId);
      eyesAnswered(messageId);
      const vocab = reactions.vocabulary(await require('../domain/flags').getFlag(pool, reactions.VOCAB_FLAG));
      placeMark({ channel: 'whatsapp', target: phone, messageId, state: 'done', emoji: vocab.done });
    }
    return out;
  }

  // "שלח לי קישור" — answered by code, before any turn exists
  // (domain/link-request.js has the why). The plugin's `before_dispatch` sends
  // a SHORT direct message here; a whole-message match mints their link and
  // hands back the sentence, which the gateway sends on the ordinary reply
  // path once the plugin claims the message. Everything that is not a match,
  // and every failure, answers `claim: false` and the model runs exactly as
  // it did before — the worst case of this path is today's behaviour.
  //
  // The body is matched and dropped: it is never logged, stored or audited,
  // and only the language that matched is.
  async function handleDashboardLinkShortcut(params = {}) {
    const agentId = String(params.agentId || '').trim();
    if (agentId === 'intake') return handleIntakeGameShortcut(params);
    if (!/^u-\d+$/.test(agentId)) return { ok: false, error: 'bad agentId' };
    const game = await handleGameShortcut(agentId, params);
    if (game) return game;
    const hit = linkRequest.matchLinkRequest(params.body);
    if (!hit) return { ok: true, claim: false };
    const messageId = reactions.cleanMessageId(params.messageId);
    let out = { ok: true, claim: false };
    let mark = null;
    let userId = null;
    await withTx(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT id, phone, locale FROM users WHERE agent_id = $1 AND status = 'active' AND is_eval = false`, [agentId]);
      const user = rows[0];
      if (!user) return;
      let text;
      if (hit.kind === 'code') {
        // "קוד כניסה" — eight digits for the home-screen app, which no link
        // can sign in on an iPhone (dashboard-auth.createCode has the why).
        // Shown as two groups of four, the way a person reads it back.
        //
        // In the language on FILE, not the one that matched: this message is
        // almost always a button's prefilled text, and the app's signed-out
        // screen may have typed it in English for somebody who writes to her
        // in Hebrew — whose reply gate would then drop an English answer.
        const made = await dashboardAuth.createCode(client, user.id);
        if (!made.ok || !made.data || !made.data.code) return;
        const shown = `${made.data.code.slice(0, 4)} ${made.data.code.slice(4)}`;
        text = templates.render(
          templates.keyFor('dashboard_code', user.locale || hit.lang), { code: shown }, await templates.load(client));
        await audit.record(client, user.id, 'dashboard.code_shortcut', { lang: hit.lang });
      } else {
        const made = await dashboardAuth.createLinkUrl(client, user.id);
        if (!made.ok || !made.data || !made.data.url) return;
        text = templates.render(
          templates.keyFor('dashboard_link', hit.lang), { url: made.data.url }, await templates.load(client));
        await audit.record(client, user.id, 'dashboard.link_shortcut', { lang: hit.lang });
      }
      userId = Number(user.id);
      out = { ok: true, claim: true, text, lang: hit.lang, kind: hit.kind };
      if (messageId) {
        const vocab = reactions.vocabulary(await require('../domain/flags').getFlag(client, reactions.VOCAB_FLAG));
        mark = { channel: 'whatsapp', target: user.phone, messageId, state: 'done', emoji: vocab.done };
      }
    });
    if (out.claim && messageId) noteAnsweredByCode(userId, messageId);
    // The link IS the answer, and a code-sent reply may reach neither signal
    // that drops a held 👀 (no model runs, so maybe no agent_end).
    if (out.claim && messageId) eyesAnswered(messageId);
    if (mark) placeMark(mark);
    return out;
  }

  // Phase B of the same feature: the gateway plugin (gateway-plugin/olma-turn,
  // `before_prompt_build`) asks for what turn_start would have RETURNED, and
  // prepends it to the prompt — so for the people turn_context_phones covers
  // the model reads its opening instead of calling for it, and a reply with no
  // tool call at all is still a counted, hinted, marked turn.
  //
  // Reads the pending open, never adopts it: the shim connection's first tool
  // call still does that, which is what keeps every mark on the real message.
  // With no open on file this answers `context: null` and records why — the
  // doctrine variant then falls back to calling turn_start, so a hook that
  // misfired costs a tool call, not a count. Never opens a turn itself: the
  // prompt build runs for cron lanes and deliveries too, and this cannot tell
  // a person writing from a job running on their agent; the hook can.
  // The gateway plugin's `llm_input` sighting of a GROUP turn: the
  // Conversation info block the gateway composed for the model, reduced to
  // the row the group sweep reads (domain/group-context.js — why this exists
  // is written there). Only the greeter and the group agents may file one,
  // only for a session of their own, and only for the group the block itself
  // names. Nothing here is user data and no turn is opened: a group turn is
  // not a person writing to her.
  async function handleGroupContext(params = {}) {
    const agentId = String(params.agentId || '').trim();
    if (!/^(ggreet|g-\d+)$/.test(agentId)) return { ok: false, error: 'bad agentId' };
    const built = groupContext.fromConversationInfo(agentId, params.sessionKey, params.info, { at: params.at });
    if (!built.ok) return { ok: false, error: built.reason };
    let wrote = false;
    await withTx(pool, async (client) => {
      await groupContext.store(client, built.row);
      // Same transaction: the room's newest message and "this member spoke"
      // are one fact, and a stamp without the context row would be a window
      // opened by a message nothing else can account for.
      wrote = await groupContext.noteMemberWrote(client, built.row);
    });
    return {
      ok: true, stored: true, members: built.row.members ? true : false,
      wasMentioned: built.row.wasMentioned, memberWrote: wrote,
    };
  }

  // A message in the room that never named her (domain/group-context.js, "A
  // message in the room that never named her" — the argument is there). The
  // plugin has already decided whether it was addressed to her, INSIDE the
  // gateway, so the room's words never come here: what arrives is the sender,
  // the room, and one boolean.
  //
  // Two answers, and they are separate on purpose. The STAMP is taken whenever
  // a member of this room wrote in it — that is the window the owner asked for
  // and it is correct with or without a flag. The CLAIM, which ends the message
  // before any model turn exists, is only ever given for a room somebody has
  // named in `group_untagged_rooms`; with the flag empty every half-state is
  // exactly today's behaviour.
  async function handleGroupRoomWrite(params = {}) {
    const agentId = String(params.agentId || '').trim();
    if (!/^g-\d+$/.test(agentId)) return { ok: false, error: 'bad agentId' };
    const externalId = String(params.externalId || '').trim();
    if (!/^[^:\s]+@g\.us$/.test(externalId)) return { ok: false, error: 'bad externalId' };
    const addressed = params.addressed !== false;
    const at = Number.isFinite(params.at) ? new Date(params.at) : new Date();
    let out = { ok: false, error: 'no group' };
    await withTx(pool, async (client) => {
      const group = await groupsDomain.getByExternalId(client, 'whatsapp', externalId);
      if (!group || group.agent_id !== agentId) return;
      const phone = groupContext.senderPhone(params.senderId);
      // Two senders the gateway used to drop before this hook ran, and which
      // the sender list now lets through (jobs/groups.syncSenderGate) because
      // there is something to do with them. Both only when the message is to
      // HER: an untagged line from either is the room talking, not them
      // coming back or asking.
      const sender = addressed && phone
        ? (await client.query(
          `SELECT id, status, paused_at FROM users WHERE phone = $1 AND NOT is_eval`, [phone])).rows[0]
        : null;
      // Somebody who has never written to her. No turn — the model would be
      // answering a person it cannot act for — but not silence either: the
      // owner's fixed line, on EVERY tag of theirs (owner, 2026-09-26: "כל פעם
      // שהוא יכתוב"), quoting the tag it answers. The key is the MESSAGE, so a
      // redelivery of one tag is still one line; a message with no id falls
      // back to its moment. The plugin claims an ADDRESSED message only on
      // this reason.
      if (sender && sender.status === 'pending') {
        const wrote = await groupContext.noteMemberWrote(client, { chatId: externalId, senderE164: phone, at });
        const messageId = typeof params.messageId === 'string' && params.messageId.trim()
          ? params.messageId.trim().slice(0, 120) : null;
        const hint = await require('../domain/group-outbox').enqueue(client, {
          groupId: group.id, kind: 'sender_hint', payload: { phone }, replyTo: messageId,
          idempotencyKey: `g${group.id}:hint:${sender.id}:${messageId || at.getTime()}`,
        });
        out = {
          ok: true, addressed, stamped: Boolean(wrote), sender: true, claim: true,
          reason: 'pending_sender', hinted: hint.ok && hint.data.queued,
        };
        return;
      }
      // Somebody paused whose next message ends their pause — the only paused
      // people the sender list admits. Their tag is that message: the pause
      // ends HERE, before the turn, the same three steps their own chat runs
      // (pause.resumeOnWrite), so the answer she gives the room is to somebody
      // who is back. A pause they confirmed is never on the list and never
      // reaches this line; resumeOnWrite would leave it standing anyway.
      const resumed = Boolean(sender && sender.status === 'active' && sender.paused_at);
      if (resumed) await require('../domain/pause').resumeOnWrite(client, sender.id);
      // An addressed message otherwise keeps the path it has always had: the
      // turn runs, and `group_context` off the Conversation info block takes
      // the stamp with the sender the GATEWAY named. Nothing to do here.
      const stamped = !addressed && phone
        ? await groupContext.noteMemberWrote(client, { chatId: externalId, senderE164: phone, at })
        : false;
      const flag = await require('../domain/flags').getFlag(client, groupContext.UNTAGGED_FLAG);
      out = {
        ok: true, addressed, stamped, sender: Boolean(phone), ...(resumed ? { resumed: true } : {}),
        claim: Boolean(!addressed && group.state === 'open'
          && groupContext.roomClaimEnabled(flag, externalId)),
      };
    });
    return out;
  }

  // The other direction, for a group turn: what the room's own rows say about
  // its coordination, drawn for the prompt (domain/group-turn.js — why this
  // exists is written there). `turn_context` is the same move for a person and
  // this is deliberately NOT that handler: there is no user row behind a group
  // agent, no turn to open, no quota to count and no flag to read. Nothing is
  // written here at all.
  //
  // The room is named TWICE and both must agree — the agent id and the room's
  // own jid off the session key — for the same reason `group_context` checks
  // it: a group agent may only ever be told about its own room, and one of the
  // two alone is a lookup that trusts the caller.
  async function handleGroupTurnContext(params = {}) {
    const agentId = String(params.agentId || '').trim();
    if (!/^g-\d+$/.test(agentId)) return { ok: false, error: 'bad agentId' };
    const externalId = String(params.externalId || '').trim();
    if (!/^[^:\s]+@g\.us$/.test(externalId)) return { ok: false, error: 'bad externalId' };
    // The gateway's own reverse map, so a tag the room writes is a person the
    // block can name. Read BEFORE the transaction and through the worker
    // facade, never `channels/sessions.js` directly: every export there is
    // synchronous and this daemon answers live users on the same loop. A
    // failure is an empty map, which costs the `lid` fields and nothing else —
    // a turn with no block at all is the one outcome worse than one with no
    // lids.
    let lidPhones = null;
    try { lidPhones = await readLidPhones(); } catch { lidPhones = null; }
    let out = { ok: false, error: 'no group' };
    await withTx(pool, async (client) => {
      const group = await groupsDomain.getByExternalId(client, 'whatsapp', externalId);
      if (!group || group.agent_id !== agentId) return;
      // A locked room has no coordination and hears nothing but the gate
      // notice, which is fixed text on the raw pipe — a block for it would be
      // a state nobody can act on.
      if (group.state !== 'open') { out = { ok: true, context: null, state: group.state }; return; }
      out = { ok: true, context: await groupTurn.renderContext(client, group, { lidPhones }) };
    });
    return out;
  }

  // The greeter's turn: the one line about the room a newcomer came from
  // (`domain/intake-room.js`). Keyed on the intake session key, whose last part
  // is the sender's number — the greeter has no identity and no user row yet.
  // `context: null` is an answer (no room), never an error; the plugin fails
  // open either way. Audited without the number: which room was named is the
  // fact worth counting, and a phone in the ledger is not.
  async function handleIntakeContext(params = {}) {
    const phone = intakeRoom.peerOf(params.sessionKey);
    if (!phone) return { ok: false, error: 'bad sessionKey' };
    let out = { ok: true, context: null };
    await withTx(pool, async (client) => {
      // Somebody with a row that says they were already introduced — the
      // greeter's session resets daily and it has no other way to know.
      const row = await usersDomain.getByPhone(client, phone);
      const introduced = intakeRoom.wasIntroduced(row);
      const room = await intakeRoom.roomFor(client, phone);
      if (!room) {
        if (introduced) out = { ok: true, context: intakeRoom.INTRODUCED_BLOCK, introduced: true };
        return;
      }
      // The room's cold invite already said hello; their reply is the yes.
      const invited = await intakeRoom.coldInviteReached(client, row && row.id, room.groupId);
      const roomBlock = intakeRoom.contextFor(room, { introduced, invited });
      out = {
        ok: true, context: introduced ? `${intakeRoom.INTRODUCED_BLOCK}\n\n${roomBlock}` : roomBlock,
        groupId: room.groupId, meetingId: room.meetingId,
        ...(introduced ? { introduced: true } : {}), ...(invited ? { invited: true } : {}),
      };
      await audit.record(client, null, 'intake.room_context_served', {
        groupId: room.groupId, meetingId: room.meetingId, ...(invited ? { invited: true } : {}),
      });
    });
    return out;
  }

  // The reply gate's report. The plugin has already decided and already acted
  // — this is the only record that it happened, so it is written even when
  // nothing was dropped (an `identifier` the closed list has not heard of is
  // exactly the row somebody needs to see before it becomes the next leak).
  //
  // The TEXT never comes here and is never stored. What leaked is the point;
  // what was in the rest of the message is the person's business, and a frame
  // marker can BE a live credential (`domain/token-leak.js`) — the plugin
  // redacts one before it leaves the gateway and this refuses to widen that.
  async function handleReplyGate(params = {}) {
    const agentId = String(params.agentId || '').trim();
    if (!/^(?:u-\d+|g-\d+|ggreet)$/.test(agentId)) return { ok: false, error: 'bad agentId' };
    const action = String(params.action || '').trim();
    if (!['pass', 'trim', 'cancel'].includes(action)) return { ok: false, error: 'bad action' };
    const leaks = (Array.isArray(params.leaks) ? params.leaks : []).slice(0, 12).map((l) => ({
      kind: String((l && l.kind) || '').slice(0, 20),
      at: replyLeak.redact(String((l && l.at) || '')).slice(0, 40),
      line: Number.isInteger(l && l.line) ? l.line : null,
    }));
    await withTx(pool, async (client) => {
      // A group agent has no user row behind it, and audit_log.actor_id is
      // nullable for exactly that: the event is still the whole record.
      const { rows } = /^u-\d+$/.test(agentId)
        ? await client.query('SELECT id FROM users WHERE agent_id = $1 AND status = \'active\'', [agentId])
        : { rows: [] };
      await require('../domain/audit').record(client, rows[0] ? Number(rows[0].id) : null, 'reply.gated', {
        agentId, action, leaks,
        kinds: [...new Set(leaks.map((l) => l.kind))],
        chars: Number.isFinite(params.chars) ? params.chars : null,
        kept: Number.isFinite(params.kept) ? params.kept : null,
        channel: params.channel ? String(params.channel).slice(0, 40) : null,
      });
    });
    return { ok: true, filed: true };
  }

  // The reply gate heard its reply claim a save ("רשמתי", "I've added") and
  // asks whether anything ran. Only the word comes here, never the reply, and
  // the answer goes nowhere but the audit log: this is a measurement, and a
  // verdict nobody has calibrated must not touch what the person reads
  // (domain/phantom-save.js).
  async function handleReplyClaim(params = {}) {
    const agentId = String(params.agentId || '').trim();
    if (agentId === 'intake') return handleIntakeGameShortcut(params);
    if (!/^u-\d+$/.test(agentId)) return { ok: false, error: 'bad agentId' };
    const word = String(params.word || '').slice(0, 20);
    let out = { ok: false, error: 'no active user for agent' };
    await withTx(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM users WHERE agent_id = $1 AND status = 'active'`, [agentId]);
      if (!rows[0]) return;
      const userId = Number(rows[0].id);
      const judged = phantomSave.judge({
        ourTurn: selfInitiated.isActive(userId),
        opens: claimOpens.get(userId) || [],
        lastToolAt: lastToolAt.has(userId) ? lastToolAt.get(userId) : null,
        lastFailAt: lastFailAt.has(userId) ? lastFailAt.get(userId) : null,
        now: clock(),
      });
      await require('../domain/audit').record(client, userId, 'reply.claim', { agentId, word, ...judged });
      out = { ok: true, verdict: judged.verdict };
    });
    return out;
  }

  // The reply gate holds a short reply and asks whether a 👍 is standing on
  // this turn's message, and if so, what the tool behind it wrote. Only the
  // WORDS of what was written go back — the gateway already carried that tool
  // result to the model — and the reply itself never comes here: the gate
  // decides locally (domain/mark-echo.js) and files a cancel through
  // `reply_gate` like any other.
  async function handleMarkEcho(params = {}) {
    const agentId = String(params.agentId || '').trim();
    if (!/^u-\d+$/.test(agentId)) return { ok: false, error: 'bad agentId' };
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE agent_id = $1 AND status = 'active'`, [agentId]);
    if (!rows[0]) return { ok: true, standing: false };
    const userId = Number(rows[0].id);
    const held = markEchoes.get(userId);
    if (!held || clock() - held.at > MARK_ECHO_MS) return { ok: true, standing: false };
    // A turn Olma started has no message of theirs a 👍 could be standing on.
    if (selfInitiated.isActive(userId)) return { ok: true, standing: false };
    return { ok: true, standing: true, words: held.words };
  }

  // A pack's server asking who a token belongs to (games/, game nights). It
  // is not a tool: the model never sees it, and the games shim calls it for
  // the token the model handed ITS tool. The same lookup, refusal wording and
  // audit row as a tool call of ours, so the shim's self-healing and the
  // dashboard's auth.failed count read it the same way.
  //
  // A person's token only. A room holds no pack, and a group token here is a
  // model in a room reaching for a tool it should never have been shown.
  //
  // What it hands back is the minimum a pack needs to act for somebody —
  // never the phone, never the token — and the packs they have, which the
  // pack's server checks itself: the gateway's deny decides what the model
  // reads, and this list decides what the server will do.
  //
  // A resolve that succeeds stamps lastToolAt, because the pack is about to
  // write for them and a "רשמתי" that follows is backed (phantom-save.judge).
  async function handleIdentityResolve(params = {}) {
    const caller = String(params.caller || 'pack').slice(0, 20);
    const token = typeof params.token === 'string' ? params.token : '';
    let out;
    await withTx(pool, async (client) => {
      const auth = await usersDomain.resolveByToken(client, token);
      const user = auth.ok ? auth.data.user : null;
      if (!user || user.status !== 'active') {
        const message = auth.ok ? 'user is not active' : auth.error.message;
        await audit.record(client, null, 'auth.failed', { tool: `${caller}:identity_resolve`, reason: message });
        out = { ok: false, error: { code: 'forbidden', message } };
        return;
      }
      const { rows } = await client.query(
        `SELECT pack FROM user_packs WHERE user_id = $1 ORDER BY pack`, [user.id]);
      out = {
        ok: true,
        user: {
          id: Number(user.id),
          name: user.first_name || null,
          timezone: user.timezone || null,
          locale: user.locale || 'he',
        },
        packs: rows.map((r) => r.pack),
      };
    });
    if (out.ok && out.packs.length) lastToolAt.set(out.user.id, clock());
    return out;
  }

  // gamesd telling us a night's count just closed (domain/game-summary.js):
  // the settlement it drew, in both languages, and the users it linked to that
  // night. The text is sent as given and nobody's model touches it. No token
  // here — gamesd is not acting for one person but reporting what a table did,
  // and the socket's owner-only mode is the door, as it is for the gateway's
  // own hooks. What it cannot do is widen the audience: only a linked person
  // who holds the pack is queued, and the result says who was not.
  async function handleGameSummary(params = {}) {
    let out;
    await withTx(pool, async (client) => {
      out = await gameSummary.queue(client, params);
      if (!out.ok) return;
      await audit.record(client, null, 'games.summary_queued', {
        caller: String(params.caller || 'games').slice(0, 20),
        nightId: Number(params.nightId), queued: out.queued.length, skipped: out.skipped.length,
      });
    });
    return out;
  }

  // The plugin telling us a person's turn has put something in front of them
  // (`reply`, from reply_payload_sending) or has ended (`end`, from agent_end —
  // the only signal for a turn that ends in silence). Either way the 👀 held
  // for the message that turn is answering is no longer needed. In memory, no
  // database: this is about a timer in this process, and it runs on every
  // reply, so it must cost nothing.
  function handleTurnProgress(params = {}) {
    const agentId = String(params.agentId || '').trim();
    if (agentId === 'intake') return handleIntakeGameShortcut(params);
    if (!/^u-\d+$/.test(agentId)) return { ok: false, error: 'bad agentId' };
    const what = params.what === 'end' ? 'end' : params.what === 'reply' ? 'reply' : null;
    if (!what) return { ok: false, error: 'bad what' };
    // Every reply says whether it ended on a question, so the newest one wins.
    if (what === 'reply') {
      if (params.asked === true) askedAt.set(agentId, clock()); else askedAt.delete(agentId);
    }
    const list = eyesOf(agentId);
    const idx = list.findIndex((e) => e.running);
    if (idx < 0) return { ok: true, held: false };
    const held = Boolean(list[idx].timer);
    stopEyes(list[idx]);
    if (what === 'end') { list.splice(idx, 1); if (!list.length) pendingEyes.delete(agentId); }
    return { ok: true, held };
  }

  async function handleTurnContext(params = {}) {
    const agentId = String(params.agentId || '').trim();
    if (agentId === 'intake') return handleIntakeGameShortcut(params);
    if (!/^u-\d+$/.test(agentId)) return { ok: false, error: 'bad agentId' };
    let out = null;
    let userId = null;
    let cardStale = false;
    await withTx(pool, async (client) => {
      // The WHOLE row, never a projection. `turn.advise` is shared with
      // `turn_start`, which resolves its user with `SELECT *` — so a column
      // this list forgot did not read as NULL here, it read as `undefined`,
      // and every branch in `advise` testing one is testing for falsy.
      // `opening_sent_at` was missing from the day this path was written; from
      // 2026-09-09 this path was EVERYBODY, and two people read the owner's
      // opening copy twice — once from the greeter, once from their own agent
      // — while `tests/first-turn.test.js` went on passing against the other
      // door (`incidents.md`, "The introduction that came back").
      // `turn.ADVISE_COLUMNS` is the guard that makes the next omission loud.
      const { rows } = await client.query(
        `SELECT * FROM users WHERE agent_id = $1 AND status = 'active'`, [agentId]);
      const user = rows[0];
      if (!user) { out = { ok: false, error: 'no active user for agent' }; return; }
      userId = Number(user.id);
      if (!await turnDomain.contextEnabledFor(client, user)) { out = { ok: true, enabled: false }; return; }
      const ourTurn = selfInitiated.isActive(user.id);
      // A turn Olma started reads no open: the person's own pending message,
      // if one is waiting, keeps its opening for its own prompt.
      const pre = ourTurn ? null : peekPending(userId);
      // The reply, from whichever side saw it: the hook (the WhatsApp quote,
      // parsed at preprocess time) or the plugin (a `reply_to_id` in the
      // prompt — which on OpenClaw 2026.8.1 it never sees, kept for a
      // gateway that changes that).
      const replyTarget = params.replyTarget === true || Boolean(pre && pre.replyToId);
      if (!pre && !ourTurn) {
        await require('../domain/audit').record(client, user.id, 'turn.context_without_open', {
          trigger: params.trigger || null, messageProvider: params.messageProvider || null,
        });
        out = { ok: true, enabled: true, context: null };
        return;
      }
      if (pre && !user.first_name && pre.senderName) {
        cardStale = (await captureDisplayName(client, user, pre.senderName)).ok;
      }
      const data = await turnDomain.advise(client, user, {
        counted: ourTurn || !pre ? { data: { blocked: false } } : pre.quota,
        // Spent on the first prompt build for this message: a rebuilt prompt
        // (model fallback) is the same message, and must not stamp twice.
        firstTurn: Boolean(pre && pre.firstTurn && !pre.contextSent),
        ourTurn, replyTarget, languageNudge: null,
        thanksOnly: Boolean(pre && pre.thanksOnly),
        thanksAfterQuestion: Boolean(pre && pre.thanksAfterQuestion),
        stoppedReminders: (pre && pre.stoppedReminders) || 0,
        chaseUntil: pre && pre.chase ? pre.chase.day : null,
        chaseNamedHour: Boolean(pre && pre.chase && pre.chase.namedHour),
        openList: Boolean(pre && pre.openList),
        remindAsk: Boolean(pre && pre.remindAsk),
      });
      if (pre) { pre.contextSent = true; eyesRunning(agentId, pre.messageId); }
      out = {
        ok: true, enabled: true, context: turnDomain.renderContext(data), directive: data.directive,
        // Not for the model — for the GATE. `reply_payload_sending` fires in
        // the same plugin, in the same turn, and decides locally with no
        // socket in the path; the one fact it cannot work out from the text is
        // who is reading it. The columns live here, so the verdict is computed
        // here and the plugin only remembers it (see `domain/language
        // .writesHebrew`, and the `english` tier in `domain/reply-leak`).
        readerWritesHebrew: require('../domain/language').writesHebrew(user),
      };
    });
    if (cardStale && userId) await refreshUserCard(pool, userId);
    return out;
  }

  async function handleToolCall(name, args, turn = newTurn()) {
    const tool = BY_NAME.get(name);
    if (!tool) return { ok: false, text: `ERROR not_found: unknown tool ${name}` };
    try {
      let actorId = null;
      // Carried out of the transaction for the acknowledgement mark below: the
      // reaction target is read from OUR row, never from anything the model sent.
      let actorPhone = null;
      // A group tool that writes to the SENDER's own record (their form of
      // address, said in the room) leaves that person's USER.md stale, and the
      // card refresh below keys on `actorId` — which a group call never sets,
      // on purpose, because everything else hung off it is person-shaped.
      let groupCardUserId = null;
      const result = await withTx(pool, async (client) => {
        // ── the group door ────────────────────────────────────────────────
        // Routed on the token's PREFIX, before the user door is even tried:
        // a group token must never be looked up among people, and a truncated
        // one must be refused as a group rather than come back "unknown
        // identity token" and send the model hunting for a person's file.
        //
        // Everything below this branch — the quota, the 👀 on somebody's
        // message, USER.md — is person-shaped and none of it applies to a
        // room. A group turn is short by construction: resolve, check the
        // audience, name the member who tagged her, run.
        if (groupsDomain.looksLikeGroupToken(readIdentity(args))) {
          const g = await groupsDomain.resolveByToken(client, readIdentity(args));
          if (!g.ok) {
            await require('../domain/audit').record(client, null, 'auth.failed', {
              tool: name, reason: g.error.message, caller: 'group',
            });
            return g;
          }
          const group = g.data.group;
          // A list is not a lock. The shim shows a group agent only its own
          // handful, but the refusal that matters is here: a group token
          // reaching a person's tool is the failure this whole design exists
          // to make impossible, so it is checked where the call actually runs.
          if (audienceOf(tool) !== 'group') {
            await require('../domain/audit').record(client, group.registered_by_user_id, 'group.tool_refused', {
              tool: name, groupId: group.id, reason: 'not a group tool',
            });
            return { ok: false, error: { code: 'forbidden', message: `${name} is not available in a group` } };
          }
          const actingUser = await groupsDomain.actingMember(client, group);
          // On the record every time, with the member it acted for: a room is
          // several people, and "who asked for this" is the first question
          // anybody will have about anything she did there.
          await require('../domain/audit').record(client, actingUser ? actingUser.id : null, 'group.tool', {
            tool: name, groupId: group.id, actingPhone: actingUser ? actingUser.phone : null,
          });
          const out = await tool.handler(client, { group, actingUser }, stripIdentity(args), { flood, now: clock });
          if (out && out.ok && actingUser && CARD_TOOLS.has(name)) groupCardUserId = actingUser.id;
          return out;
        }

        const auth = await usersDomain.resolveByToken(client, readIdentity(args));
        if (!auth.ok) {
          // Every auth failure is on the record: a bug or an attempt, and in
          // both cases something the dashboard should surface.
          await require('../domain/audit').record(client, null, 'auth.failed', {
            tool: name, reason: auth.error.message,
          });
          return auth;
        }
        // The mirror of the refusal above: these tools answer to a room, and
        // a person calling one would be asking about a group from inside a
        // private chat where nobody else can see what was asked.
        if (audienceOf(tool) === 'group') {
          return { ok: false, error: { code: 'forbidden', message: `${name} is only available to a group` } };
        }
        actorId = auth.data.user.id;
        actorPhone = auth.data.user.phone;

        // The first tool of the turn decides whether the turn was opened
        // properly. `turn_start` opens it itself; anything else means the
        // model skipped the call, and the record has to be repaired by the
        // one layer that cannot forget (see domain/turn.js).
        //
        // A connection that ever serves a different user is not the same turn,
        // whatever the transport thinks.
        if (turn.userId !== actorId) {
          turn.userId = actorId;
          turn.opened = false; turn.counted = false; turn.quota = null;
          // Cleared with the rest, and this one is not bookkeeping: a message id
          // left over from the previous occupant of this connection would aim a
          // reaction at somebody else's message from inside this person's chat.
          turn.messageId = null; turn.lastInboundAt = null;
          turn.marked = null;
        }

        // ── A pending open is adopted on ANY call, not the connection's first ─
        // This was `if (!turn.opened)` for two days, and `turn.opened` is a
        // latch that only ever clears on a change of user — which never
        // happens, one agent serving one person. But the shim caches ONE
        // socket for the life of the MCP process (`bin/olma-mcp.js`), and that
        // process outlives the turn by hours. So the FIRST message the process
        // ever saw froze itself into `turn.messageId`, and every turn after it
        // marked that message instead of its own: Miron got an ⏰ on a message
        // he had sent five minutes and forty seconds earlier, and once the
        // frozen id aged past the live window Yahav's evening earned no closing
        // mark at all for six hours (`incidents.md`, "The mark that never
        // moved"). Every 👀 anyone saw in between was the gateway's own
        // `ackReaction`, which is why the feature looked alive throughout.
        //
        // Adopting per call is safe against the double-count this latch was
        // guarding: `takePending` REMOVES the entry, so each opening — and each
        // count, quota and first-turn verdict on it — is consumed exactly once,
        // by whichever call gets there first. Later calls in the same turn find
        // nothing pending and keep what they hold.
        const pre = takePending(actorId);
        if (pre) {
          turn.opened = true;
          turn.counted = pre.counted; turn.quota = pre.quota; turn.firstTurn = pre.firstTurn;
          turn.messageId = pre.messageId; turn.lastInboundAt = pre.lastInboundAt;
          turn.messageKind = pre.kind; turn.marked = pre.marked; turn.reactionVocab = pre.reactionVocab;
          turn.thanksOnly = pre.thanksOnly;
          turn.thanksAfterQuestion = Boolean(pre.thanksAfterQuestion);
          turn.stoppedReminders = pre.stoppedReminders || 0;
          turn.chase = pre.chase || null; turn.chaseUsed = false;
          turn.openList = Boolean(pre.openList);
          turn.remindAsk = pre.remindAsk || null; turn.remindAskUsed = false;
          turn.openedByGateway = true;
        } else if (!turn.opened) {
          // No gateway open on file and this connection has not served a turn
          // yet: the model skipped `turn_start` and the record needs repairing.
          // Still latched, and deliberately — without an opening there is
          // nothing that can tell one turn from the next on this socket, so a
          // per-call recovery would count a single message once per tool.
          turn.opened = true;
          if (name !== 'turn_start' && await turnDomain.isEnabledFor(client, auth.data.user)) {
            const recovered = await turnDomain.openTurnImplicitly(client, auth.data.user, { firstTool: name });
            turn.counted = recovered.counted;
            turn.quota = recovered.quota;
            // Only this path still saw a NULL last_inbound_at; it has just
            // overwritten it, so a turn_start later in the same turn can no
            // longer tell a first message from a thousandth one.
            turn.firstTurn = recovered.firstTurn;
          }
        } else if (turn.messageId && !reactions.isLive(turn.lastInboundAt, clock())) {
          // Nothing to adopt, and the opening we are still holding is older
          // than the window a mark may be placed in — so it belongs to a turn
          // that has ended. `markFor` would refuse it anyway; dropping it here
          // says so once, where the id lives, instead of leaving a dead message
          // id on the turn for every later reader to have to distrust.
          turn.messageId = null; turn.lastInboundAt = null; turn.marked = null;
        }

        const out = await tool.handler(client, auth.data.user, stripIdentity(args), { flood, turn, now: clock });
        // The recovery's count is worth exactly one `turn_start`. Clearing it
        // here means a connection that outlives its turn cannot make the NEXT
        // turn's turn_start believe its message was already counted — which
        // would be this fix causing the very thing it exists to prevent.
        // `firstTurn` is spent by the same rule and cleared in the same
        // breath: a connection that outlives its turn must not hand the NEXT
        // message a leftover "this person is brand new".
        if (name === 'turn_start') { turn.counted = false; turn.quota = null; turn.firstTurn = false; }
        return out;
      });
      // Identity-shaping calls re-render the user's USER.md card — outside
      // the transaction on purpose, so the card always reflects committed
      // state and a file hiccup can never fail the tool call itself.
      // Two ways a call can leave the card stale: the tool always changes a
      // card field (CARD_TOOLS), or the handler decided this particular call
      // did (result.cardStale — see registry.stale, used by turn_start, which
      // runs on every message and so must not re-render on every message).
      if (actorId && result && result.ok && (CARD_TOOLS.has(name) || result.cardStale)) {
        await refreshUserCard(pool, actorId);
      }
      if (groupCardUserId && result && result.ok) await refreshUserCard(pool, groupCardUserId);
      // Any tool that ran for them backs a reply saying it saved something —
      // turn_start excepted, which runs on every message and saves nothing.
      if (actorId && result && result.ok && name !== 'turn_start') lastToolAt.set(Number(actorId), clock());
      if (actorId && result && !result.ok && name !== 'turn_start') lastFailAt.set(Number(actorId), clock());
      // The acknowledgement mark on the person's own message — 👀 as the turn
      // opens, ⏰ or ✅ as the work lands. Here, and not inside the handlers,
      // because every tool already passes through this one line: the table of
      // what earns which mark lives in domain/reactions.js and nothing else has
      // to know the feature exists.
      //
      // Outside the transaction and after the card refresh, for the same reason
      // that refresh is: this is decoration, and it may never fail a tool call
      // or hold one open. `placeMark` swallows its own failures and the target
      // is the user's OWN phone out of our database — never anything the model
      // supplied — so a wrong id can only mark a different message in the same
      // person's chat with Olma.
      // The injected clock, not `Date.now()`: the turn's `lastInboundAt` was
      // written from it, and a liveness test where the two sides read different
      // clocks is one no test can pin.
      const mark = reactions.markFor(name, result, turn, clock());
      let placed = null;
      if (mark && actorPhone) {
        if (mark !== 'working' && mark !== 'listening') eyesAnswered(turn.messageId);
        placed = placeMark({
          channel: 'whatsapp', // the one channel whose reactions we have verified
          target: actorPhone,
          messageId: turn.messageId,
          state: mark,
          // The operator's vocabulary, read once when the turn opened. Absent
          // (a direct dispatch, a turn that never called turn_start) means the
          // built-in table, which is the same thing this did before it was
          // configurable at all.
          emoji: turn.reactionVocab && turn.reactionVocab[mark],
        });
        // What is now standing on their message, for the hint below. Recorded
        // where the attempt is made, so a mark nobody could spawn is never
        // claimed — `attempted`, never `sent`, exactly as the hint says.
        if (placed && placed.attempted) reactions.noteMarkAttempted(turn, mark);
      }
      // Miron, 2026-09-05, having deleted a task by reply: he got the 👍 AND a
      // sentence saying it was deleted. The mark already says "done"; words
      // after it are a second notification for the same fact. So when — and
      // only when — a done-mark was asked for on this message, the result says
      // so, and the model is told the mark may be the whole answer. It rides
      // the RESULT rather than the doctrine: it costs tokens only on the turns
      // it applies to, and it arrives at the exact moment the model decides
      // what to write (the same budget rule as turn_start's hints).
      // `attempted`, never `sent` — placeMark makes no delivery claim, and
      // neither does this: the instruction is about not repeating the mark's
      // meaning, not about relying on the mark having landed.
      // The hint follows the MARK, not the spawn. `markFor` dedupes on message
      // AND state, so the SECOND done-tool of a turn gets null from it and
      // used to get no hint either — which is how Gali's `complete_task`, the
      // last thing the model read before writing, came back saying nothing at
      // all while a 👍 was already on her message (2026-09-10; see
      // reactions.doneMarkStands). One mark, and every result that earned it
      // says so.
      if (reactions.doneMarkStands(name, result, turn, clock()) && result.data && typeof result.data === 'object') {
        result.data.hints = {
          ...(result.data.hints || {}),
          markPlaced: 'A 👍 has already been put on their message: it tells them this is done. '
            + 'If they gave a plain instruction and you have nothing to add — no question worth '
            + 'asking, no caveat, no error, no other hint here — reply with exactly NO_REPLY and '
            + 'nothing else. Write only when the words carry something the mark cannot.',
        };
        if (actorId) {
          const prev = markEchoes.get(Number(actorId));
          const words = [...(prev ? prev.words : []), ...markEcho.vocabOf(result.data)].slice(0, 60);
          markEchoes.set(Number(actorId), { at: clock(), words });
        }
      } else if (actorId && name !== 'turn_start') {
        markEchoes.delete(Number(actorId));
      }
      return { ok: true, text: renderResult(result) };
    } catch (e) {
      // Never leak internals to the agent; full error goes to the journal.
      console.error(`[brokerd] ${name} failed:`, e);
      return { ok: false, text: 'ERROR internal: tool failed, try again or report' };
    }
  }

  // `turn` is supplied by the connection handler below. It defaults to a fresh
  // one so a direct dispatch() — every test, and the ping path — behaves like
  // a turn of its own rather than depending on a caller it does not have.
  async function dispatch(msg, turn = newTurn()) {
    if (!msg || typeof msg !== 'object') return { ok: false, error: 'bad message' };
    switch (msg.method) {
      case 'ping':
        return { ok: true, pong: true, pid: process.pid };
      case 'tool_call': {
        const { name, args } = msg.params || {};
        return handleToolCall(name, args, turn);
      }
      case 'turn_open':
        return handleTurnOpen(msg.params || {});
      case 'turn_context':
        return handleTurnContext(msg.params || {});
      case 'group_context':
        return handleGroupContext(msg.params || {});
      case 'group_turn_context':
        return handleGroupTurnContext(msg.params || {});
      case 'intake_context':
        return handleIntakeContext(msg.params || {});
      case 'group_room_write':
        return handleGroupRoomWrite(msg.params || {});
      case 'dashboard_link_shortcut':
        return handleDashboardLinkShortcut(msg.params || {});
      case 'reply_gate':
        return handleReplyGate(msg.params || {});
      case 'reply_claim':
        return handleReplyClaim(msg.params || {});
      case 'mark_echo':
        return handleMarkEcho(msg.params || {});
      case 'turn_progress':
        return handleTurnProgress(msg.params || {});
      case 'identity_resolve':
        return handleIdentityResolve(msg.params || {});
      case 'game_summary':
        return handleGameSummary(msg.params || {});
      default:
        return { ok: false, error: `unknown method ${msg.method}` };
    }
  }

  const server = net.createServer((socket) => {
    // One connection, one shim, one turn — see newTurn() above.
    const turn = newTurn();
    let buf = '';
    socket.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > 8 * 1024 * 1024) { // bound per-connection memory
        buf = '';
        socket.destroy();
        return;
      }
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { socket.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n'); continue; }
        const res = await dispatch(msg, turn);
        socket.write(JSON.stringify({ id: msg.id, ...res }) + '\n');
      }
    });
    socket.on('error', () => { /* client vanished mid-write; nothing to do */ });
  });

  function listen(sockPath) {
    fs.mkdirSync(require('node:path').dirname(sockPath), { recursive: true }); // run/ may not survive deploys
    if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); // stale socket from a crash
    return new Promise((resolve) => server.listen(sockPath, () => {
      // The socket is an unauthenticated door into every user's data — the
      // only thing guarding it is the filesystem. Owner-only, explicitly.
      try { fs.chmodSync(sockPath, 0o600); } catch { /* best effort */ }
      resolve(server);
    }));
  }

  return { server, listen, dispatch, flood, pendingCount: () => [...pending.values()].reduce((n, l) => n + l.length, 0) };
}

module.exports = { createBrokerServer };
