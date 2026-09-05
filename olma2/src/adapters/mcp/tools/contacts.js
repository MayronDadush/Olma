'use strict';
// contacts — one slice of the tool registry (see ../registry.js).
const {
  grants, contacts, S, tool,
} = require('./_shared');

module.exports = [
  // A shared WhatsApp contact card is visible to you for exactly ONE turn: the
  // gateway persists it into history as the bare placeholder `<contact>` with
  // the name and number stripped out. Save it the moment it arrives or it is
  // gone — see migration 009 for the live incident that proved this.
  tool('save_contact', 'Save someone to the address book. Call IMMEDIATELY when a contact card arrives — its name and number are visible only this turn, then erased from history. Also for dictated numbers. Silent bookkeeping: messages nobody, grants nothing.',
    { name: S('string', 'Their name as shown on the card'),
      phone: S('string', 'Their number, any format'),
      source: S('string', 'contact_card (shared as a card) | user_stated (typed or dictated)'),
      note: S('string', 'Optional short note about who they are') },
    ['name', 'phone'],
    (client, user, a) => contacts.saveContact(client, user.id, a)),
  tool('list_my_contacts', 'The user\'s saved contacts, optionally filtered by a name or number fragment. Check here BEFORE asking anyone for a phone number.',
    { query: S('string', 'Optional name or digits to filter by') }, [],
    (client, user, a) => contacts.listContacts(client, user.id, { query: a.query })),
  tool('forget_contact', 'Remove someone from the address book. Ask the user first.',
    { contact_id: S('number', 'Contact id') }, ['contact_id'],
    (client, user, a) => contacts.forgetContact(client, user.id, a.contact_id)),
];
