'use strict';
// bulk contact import — one slice of the tool registry (see ../registry.js).
const {
  googleContacts, contacts, S, ok, tool,
} = require('./_shared');

module.exports = [
  // Importing is silent bookkeeping — same doctrine as save_contact, at scale.
  // It messages nobody, creates no connection, and reveals to nobody that this
  // user is on Olma. It just fills the address book above so nobody's number
  // is ever asked for twice.
  tool('start_contacts_connection', 'Begin importing the user\'s Google Contacts (read-only) into their private address book here on Olma. Returns a link for them to open. Tell them plainly: importing is private — it does not message anyone and does not create any connection.',
    {}, [],
    (client, user) => googleContacts.beginConnection(client, user.id)),
  tool('import_google_contacts', 'Import (or re-sync) the user\'s Google contacts now. Call this the moment a contacts_connected notice arrives, or any time the user asks to re-sync after adding people on their phone. Report the counts back in one short sentence — imported / updated / skipped. Contacts the user already renamed by hand are never overwritten.',
    {}, [],
    (client, user) => googleContacts.importFromGoogle(client, user.id)),
  tool('contacts_connection_status', 'Whether the user\'s Google contacts are connected for import, and under which account.', {}, [],
    (client, user) => googleContacts.getStatus(client, user.id)),
  tool('disconnect_google_contacts', 'Stop syncing from Google Contacts (also revokes access at Google). The contacts already imported stay in the address book — this only stops future syncing. Confirm with the user first.', {}, [],
    (client, user) => googleContacts.disconnect(client, user.id)),
  tool('import_contacts_file', 'The user sent a vCard (.vcf) file — call this THIS TURN with the path the system just showed you for it. Never invent or reuse a path from an earlier turn; the file is only visible to you on the turn it arrives. Report the counts back in one short sentence.',
    { path: S('string', 'The exact file path shown to you this turn') }, ['path'],
    async (client, user, a) => {
      const contactFile = require('../../../domain/contact-file');
      const vcard = require('../../../domain/vcard');
      const read = contactFile.readInboundVcf(a.path);
      if (!read.ok) return read;
      const entries = vcard.parseVCards(read.data.text);
      return contacts.importContacts(client, user.id, entries, 'vcard');
    }),
];
