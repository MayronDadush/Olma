'use strict';
// profile — one slice of the tool registry (see ../registry.js).
const {
  users, dashboardAuth, quota, pause, voice, S, ok, tool,
} = require('./_shared');

module.exports = [
  tool('get_my_profile', 'Your own profile: name, timezone, plan, digest settings.', {}, [],
    async (client, user) => {
      const plan = await quota.planFor(client, user.id);
      return ok({
        firstName: user.first_name, lastName: user.last_name,
        timezone: user.timezone, timezoneConfirmed: user.timezone_confirmed,
        locale: user.locale, plan, digestTimes: user.digest_times, digestScope: user.digest_scope,
      });
    }),
  tool('set_my_name',
    'Save what this person is called, the moment you know it: confirmed=true when they told you themselves ("קוראים לי חיים"); confirmed=false (the default) for a name you merely saw — the WhatsApp display name, or one that came up in conversation. A name never belongs in remember_fact. An unconfirmed guess is worth saving: it lets you greet them and check it in passing, and it never overwrites a confirmed name.',
    {
      first_name: S('string', 'First name'),
      last_name: S('string', 'Last name (optional)'),
      confirmed: S('boolean', 'TRUE only when they stated it themselves. Default FALSE.'),
    }, ['first_name'],
    async (client, user, a, ctx) => {
      const res = await users.setName(client, user.id, a.first_name, a.last_name,
        { confirmed: a.confirmed === true, source: a.confirmed === true ? 'user_stated' : 'observed' });
      if (!res.ok || a.confirmed !== true) return res;
      // The beat the onboarding was missing. Walking a cold start on a real
      // phone (2026-09-04) ended at "מירון, נעים להכיר ☺️ אני פה לכל מה
      // שתצטרך" — warm, and a dead end: the person has just introduced
      // themselves and has no idea what to say next, so they say nothing.
      // The opening message deliberately asks nothing (one question per reply,
      // and brand copy is not the place for it), which leaves exactly one
      // moment to make the ask, and it is this one.
      //
      // Conditional on their list actually being empty, so it fires for
      // someone with nothing yet and never nags a person who has already been
      // using Olma for a month and only now confirmed their name. Rides in the
      // result, not in the doctrine, for the budget reason at turn_start's
      // return: 39249 of 39250 chars are spent.
      // …and NOT on the opening turn itself. turn_start's firstTurn
      // instruction already owns what that reply says — the owner's brand
      // copy, verbatim, alone — and two unconditional instructions about what
      // to write in one turn is the failure recorded in CLAUDE.md under
      // "markPlaced is CONDITIONAL": the hint was neither missing nor
      // ignored, it was outvoted. Since 2026-09-07 that turn calls this tool
      // (a person whose first message is "קוראים לי עידן"), so the collision
      // is now reachable and had to be decided rather than left to the model.
      //
      // Nothing is lost by it. The dead end nextStep exists to fix is the
      // person whose ONLY message was their name, answering a greeting; a
      // person who opened the conversation themselves is not standing at one
      // — עידן's very next message was a real question.
      //
      // The test is the same invariant the 60-second rung uses: turn_start
      // stamps first_turn_at and last_inbound_at in one statement, so they
      // can only still be equal while that first turn is the latest thing
      // that happened (tests/first-turn.test.js).
      const { rows } = await client.query(
        `SELECT EXISTS (SELECT 1 FROM tasks WHERE owner_id = $1) AS has_tasks,
                (SELECT first_turn_at IS NOT NULL AND first_turn_at = last_inbound_at
                   FROM users WHERE id = $1) AS opening_turn`, [user.id]);
      // `turn.firstTurn` covers the other door into the same turn: a model
      // that reached for this tool BEFORE turn_start leaves first_turn_at
      // still NULL (brokerd's recovery opened the turn, and only turn_start
      // stamps that column), so the timestamps alone would read "not the
      // opening turn" on the one turn that most is. The verdict is on the
      // turn object either way.
      if (rows[0].has_tasks || rows[0].opening_turn || (ctx && ctx.turn && ctx.turn.firstTurn === true)) return res;
      return ok({ ...res.data,
        nextStep: 'They have just told you their name and their list is still empty. '
          + 'Greet them by it in one short line, then — in the same reply — invite them '
          + 'to pour out whatever is on their plate: tasks, things to remember, people to '
          + 'get back to, as messy and unsorted as they like, by text or voice note. Make '
          + 'it feel like dumping, not like filling a form: no categories, no examples '
          + 'list, no questions to answer first. One invitation, warm, and then stop.' });
    }),
  // The personal dashboard. A LINK, not a page the agent renders — everything
  // it shows already exists here, so nothing about this tool decides what a
  // person sees; it only decides whether they can look at it on a screen
  // instead of asking for it a sentence at a time.
  tool('open_my_dashboard',
    'A personal link to THIS user\'s own dashboard: tasks and archive, connections and what each may do, connected accounts, timezone — all editable there. Offer it when they want to SEE or rearrange several things at once, or ask for a link or a screen. Put the URL in your reply; it opens once and stays open. Everything on it can still be done here in chat — never the answer to a question you can just answer.',
    { meeting_id: S('number', 'Optional: open the page ON this meeting (its tab and sheet). Only when the reply\'s hints asked for it, or they want to see a specific coordination.') }, [],
    (client, user, a) => dashboardAuth.createLinkUrl(client, user.id, { meetingId: a.meeting_id })),

  // The tools that did not exist when a user asked to stop and Olma, having
  // nothing to call, simply said goodbye and messaged him again the next
  // morning. Pausing is reversible and deletes nothing — see domain/pause.js.
  tool('pause_olma',
    'Stop Olma from EVER reaching out again: check-ins, reminders, digests, anything another person would have triggered. Call it when someone asks to stop, pause or unsubscribe — after ONE short confirming question and their yes, never on a guess. Deletes NOTHING; resume_olma puts everything back, and you still answer when they write. Tell them plainly you will not write again and they can come back any time by sending a message.',
    { note: S('string', 'What they said, in their own words, if they gave a reason') }, [],
    (client, user, a) => pause.pauseUser(client, user.id, { note: a.note })),
  // The voice bridge (a separate process, loopback port 8792) decides who may
  // be called — this tool just asks it to dial and relays the answer.
  tool('call_me_on_the_phone',
    'Place a REAL phone call from Olma\'s number to this user — they answer and talk to Olma out loud. Call it when they ask to be called or to talk by voice, in any phrasing — the intent matters, not the words. Never offer or mention it unless they raise it, never call on a guess. On ok say the phone will ring within seconds; on an error relay it plainly (usually calls are not enabled for their number yet).',
    {}, [],
    (client, user) => voice.requestCall(client, user)),
  tool('resume_olma',
    'Turn Olma\'s proactive messages back on for someone who had paused, and re-arm the repeating '
    + 'reminders the pause took down (each returns at its own next real time, never at a moment that '
    + 'has already passed). Only on their explicit ask — a paused person writing to you once is not a '
    + 'request to be messaged again. Afterwards, tell them what came back.',
    {}, [],
    (client, user) => pause.resumeUser(client, user.id)),
  tool('set_my_timezone', 'Set the IANA timezone — THE TURN someone reveals where they actually are ("אני בניו יורק", a trip they mention). A phone number only guesses a country, and every reminder, digest and quiet-hours window runs on this value, so a wrong zone means 3am messages. confirmed=true only when they explicitly confirmed it. If the result carries hints, follow them: they name times that were corrected and meetings to re-propose.',
    { timezone: S('string', 'IANA name, e.g. Asia/Jerusalem'), confirmed: S('boolean', 'User explicitly confirmed') }, ['timezone'],
    async (client, user, a) => {
      const res = await users.setTimezone(client, user.id, a.timezone, a.confirmed);
      if (!res.ok) return res;
      // The guidance for the repair, only on the call where something was
      // actually repaired — it used to be half the tool description, paid on
      // every turn for a case that happens once per user at most.
      const d = res.data || {};
      const hints = {};
      if ((d.movedTasks && d.movedTasks.length) || (d.movedReminders && d.movedReminders.length)) {
        hints.moved = 'movedTasks/movedReminders were saved under a zone Olma had only GUESSED and '
          + 'are now corrected: say in one line that their existing times were off and are fixed — '
          + 'they lived with a wrong hour and deserve to know.';
      }
      if (d.meetingsToRecheck && d.meetingsToRecheck.length) {
        hints.meetingsToRecheck = 'These were NOT moved: the other person agreed to that exact '
          + 'moment. Name them and ask whether to re-propose.';
      }
      return Object.keys(hints).length ? ok({ ...d, hints }) : res;
    }),
  tool('set_my_language', 'Change the language you speak and store their data in. ONLY on their explicit request ("talk to me in English") — never because one message happened to be in another language.',
    { locale: S('string', 'ISO code, e.g. he, en, ar, ru') }, ['locale'],
    (client, user, a) => users.setLocale(client, user.id, a.locale)),
  tool('set_assistant_persona',
    'Change who Olma IS for this user: gender ("תהיה גבר" / "תחזרי להיות אישה") and/or the name '
    + 'they call the assistant ("אני רוצה לקרוא לך נועה"; an empty name resets to עולמה). ONLY on '
    + 'their explicit request — never offer or suggest it. From your very next sentence on, follow '
    + 'the new persona: gender changes EVERY Hebrew self-reference (אני בודק/בודקת, verbs and '
    + 'adjectives alike, no mixing), and the name replaces עולמה everywhere — phone calls included.',
    { gender: S('string', 'female | male'), name: S('string', 'New assistant name; "" resets to the default') }, [],
    (client, user, a) => users.setAssistantPersona(client, user.id, { gender: a.gender, name: a.name })),
];
