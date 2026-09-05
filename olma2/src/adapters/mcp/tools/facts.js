'use strict';
// facts — one slice of the tool registry (see ../registry.js).
const {
  connections, availability, digest, calendar, facts, S, tool,
} = require('./_shared');

module.exports = [
  // Deep memory. Most facts arrive from the extraction job reading a finished
  // conversation, not from these tools — they exist for the moment someone
  // states something outright ("my daughter starts school in September") and
  // for correcting what was learned wrong.
  tool('remember_fact', 'Store a durable fact about this person (still true in a month). NOT a task (add_task), NOT a phone number or who-knows-whom (connections), NOT how they like you to work (remember_preference), NOT Olma state the card already shows. A constraint about ONE meeting belongs to record_meeting_constraint; store it here only when they generalise it ("אני אף פעם לא נפגשת בשבת"), and a standing availability rule is remember_preference key availability. expires_at is REQUIRED when the fact names a date or a moving day ("היום", "מחר", "29.8") — refused without one.',
    { category: S('string', 'work | family | people | health | plans | habits | context'),
      fact: S('string', 'The fact, one short sentence in their language'),
      importance: S('number', '1 ordinary (default) | 2 important | 3 core'),
      expires_at: S('string', 'Optional ISO datetime after which this stops being true') },
    ['category', 'fact'],
    (client, user, a) => facts.rememberFact(client, user.id, {
      category: a.category, fact: a.fact, importance: a.importance,
      expiresAt: a.expires_at, source: 'user_stated',
    })),
  tool('forget_fact', 'Stop using a fact — when the person corrects it or it stops being true. Reversible on our side; the record is kept, just not used.',
    { fact_id: S('number', 'Fact id from list_my_facts') }, ['fact_id'],
    (client, user, a) => facts.forgetFact(client, user.id, a.fact_id)),
  tool('list_my_facts', 'Everything you know about this person, or a filtered slice of it. The most important facts are already in your USER.md every turn — reach for this when you need older or narrower context than that.',
    { category: S('string', 'Optional: work | family | people | health | plans | habits | context'),
      query: S('string', 'Optional text to match within facts') }, [],
    (client, user, a) => facts.listFacts(client, user.id, { category: a.category, query: a.query })),
];
