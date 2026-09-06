'use strict';
// Fixed first-contact texts. The first messages a person ever gets from Olma
// are never improvised by the model (v1 shipped a typo and a wrongly guessed
// grammatical gender that way) — the model is told to send these EXACTLY.
//
// The sentences are in domain/message-templates.js, where the owner rewords
// them from the admin page; `overrides` is that stored object, loaded by the
// caller (both callers hold a client).
const templates = require('../domain/message-templates');

function isHebrewPhone(phone) {
  return String(phone || '').replace(/[^\d]/g, '').startsWith('972');
}

// The stranger intro — sent when an existing user asked to connect with a
// phone that isn't on Olma yet. Reflects exactly why we're reaching out:
// who (name + phone, so they recognise them) and what for.
function introMessage({ inviterName, inviterPhone, reason, phone }, overrides) {
  const vars = {
    inviter_name: inviterName, inviter_phone: inviterPhone,
    reason: reason ? ` — ${reason}` : '',
  };
  return templates.render(isHebrewPhone(phone) ? 'stranger_intro_he' : 'stranger_intro_en', vars, overrides);
}

// The reopen notice for waitlisted strangers — the promise we made kept.
function reopenMessage(phone, overrides) {
  return templates.render(isHebrewPhone(phone) ? 'reopen_he' : 'reopen_en', {}, overrides);
}

module.exports = { introMessage, reopenMessage, isHebrewPhone };
