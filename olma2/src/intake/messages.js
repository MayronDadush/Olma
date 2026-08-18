'use strict';
// Fixed first-contact texts. The first messages a person ever gets from Olma
// are never improvised by the model (v1 shipped a typo and a wrongly guessed
// grammatical gender that way) — the model is told to send these EXACTLY.

function isHebrewPhone(phone) {
  return String(phone || '').replace(/[^\d]/g, '').startsWith('972');
}

// The stranger intro — sent when an existing user asked to connect with a
// phone that isn't on Olma yet. Reflects exactly why we're reaching out:
// who (name + phone, so they recognise them) and what for.
function introMessage({ inviterName, inviterPhone, reason, phone }) {
  if (isHebrewPhone(phone)) {
    return [
      `היי! כאן אולמה — עוזרת אישית שעובדת בוואטסאפ.`,
      ``,
      `${inviterName} (${inviterPhone}) ביקש/ה להתחבר אליך דרכי${reason ? ` — ${reason}` : ''}.`,
      ``,
      `אם זה מעניין אותך, פשוט תענה/י לי כאן ואספר איך זה עובד. אם לא — אפשר להתעלם, ולא אכתוב שוב.`,
    ].join('\n');
  }
  return [
    `Hi! This is Olma — a personal assistant that lives in WhatsApp.`,
    ``,
    `${inviterName} (${inviterPhone}) asked to connect with you through me${reason ? ` — ${reason}` : ''}.`,
    ``,
    `If you're curious, just reply here and I'll explain how it works. If not — feel free to ignore this, I won't write again.`,
  ].join('\n');
}

// The reopen notice for waitlisted strangers — the promise we made kept.
function reopenMessage(phone) {
  if (isHebrewPhone(phone)) {
    return 'היי! כאן אולמה — פנית אליי כשלא הייתה אפשרות לצרף משתמשים חדשים. עכשיו נפתח מקום! אם עדיין רלוונטי, פשוט תענה/י לי כאן ונתחיל 🙂';
  }
  return "Hi! Olma here — you reached out while new sign-ups were paused. There's room now! If you're still interested, just reply here and we'll get started 🙂";
}

module.exports = { introMessage, reopenMessage, isHebrewPhone };
