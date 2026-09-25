'use strict';
// Who the dial API will ring. Two doors, and they are not the same size:
//
//  - A number in VOICE_ENABLED_PHONES may be called by any caller, for as long
//    as the bridge's own default allows. This is the chat tool's door
//    (`call_me_on_the_phone`), which olma2 does NOT cap, so it stays a list.
//
//  - Anybody else may be called only by a CAPPED dial: olma2's dashboard path,
//    which has already spent one of that person's two lifetime attempts
//    (domain/voice.CALL_ATTEMPTS_LIMIT) and asks for a short call. The owner
//    opened the page button to everybody on 2026-09-15 with exactly those two
//    guardrails, and until this the bridge refused every number not on the
//    list — the button showed for all and rang for almost nobody.
//
// A capped dial must say so explicitly AND carry a duration inside the cap. An
// olma2 that predates the `capped` field sends neither, and gets the list —
// the same answer it always got. The users-table check (active, not eval)
// still runs after this for both doors.
const CAPPED_MAX_DURATION_SEC = 120;

function admits({ phone, capped, maxDurationSec }, allowlist) {
  if (!phone) return false;
  if (allowlist.includes(phone)) return true;
  return capped === true
    && Number.isFinite(maxDurationSec)
    && maxDurationSec > 0
    && maxDurationSec <= CAPPED_MAX_DURATION_SEC;
}

module.exports = { admits, CAPPED_MAX_DURATION_SEC };
