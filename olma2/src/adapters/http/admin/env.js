'use strict';
// Where the gateway config lives, for the three places the admin page reads it.
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const occ = require('../../../intake/openclaw-config');

const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG || occ.DEFAULT_PATH;

module.exports = { OPENCLAW_CONFIG_PATH };
