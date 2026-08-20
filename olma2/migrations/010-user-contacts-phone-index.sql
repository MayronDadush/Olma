-- A phone number in one person's address book is also evidence of what
-- someone else calls that number — "user 3 has this number saved as 'אמא'"
-- is exactly the fact a fresh provisioning step wants when it is about to ask
-- a brand new user what to call them. Bulk import (Google Contacts / vcf,
-- olma2/src/domain/google-contacts.js, vcard.js) is about to make that
-- reverse lookup a real per-phone scan across the whole table instead of a
-- handful of manually-saved cards, so the index earns its keep now rather
-- than after the first slow query in production.
CREATE INDEX user_contacts_phone ON user_contacts (phone);
