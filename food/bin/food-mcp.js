#!/usr/bin/env node
// The food MCP shim, registered with the gateway as `mcp.servers.food`
// (olma2/scripts/register-food-mcp.js). Like olma2/bin/olma-mcp.js it is
// spawned per session and does almost nothing: tools/list from
// src/tool-defs.js (no pg, no store), tools/call as one POST to foodd on
// the box, text back. A copy of games/bin/games-mcp.js with the names changed.
//
// Every agent is denied `food__*` unless its person holds the pack
// (olma2/src/intake/agent-tool-policy.js), and foodd refuses the call anyway
// for anybody brokerd does not say holds it. This file trusts neither.
//
// Identity self-healing, the narrow half of olma-mcp.js's: a MALFORMED token
// is replaced by the person's token that already succeeded on this stdio
// connection. A well-formed unknown one is passed through to fail. A room's
// token is never proven here (a room holds no pack), so nothing can cross.
'use strict';
const http = require('node:http');
const readline = require('node:readline');
const { TOOL_DEFS, IDENTITY_PARAM } = require('../src/tool-defs');

const PORT = Number(process.env.FOOD_PORT || 8795);
const CALL_TIMEOUT_MS = 30_000;
const USER_TOKEN_RE = /^olma_tok_[0-9a-f]{32}$/;
let knownGoodToken = null;

function callFood(name, args) {
  const body = JSON.stringify({ name, args });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/tool', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: CALL_TIMEOUT_MS,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error(`unreadable reply (${res.statusCode})`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('food service timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'food', version: '0.1.0' },
      });
    } else if (method === 'notifications/initialized') {
      // notification, no response
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOL_DEFS });
    } else if (method === 'tools/call') {
      const { name, arguments: rawArgs } = params || {};
      const args = { ...(rawArgs || {}) };
      if (knownGoodToken && !USER_TOKEN_RE.test(String(args[IDENTITY_PARAM] || ''))) args[IDENTITY_PARAM] = knownGoodToken;
      let text;
      try {
        const res = await callFood(name, args);
        text = typeof res.text === 'string' ? res.text : 'ERROR internal: empty reply from the food service';
        if (text.startsWith('OK') && USER_TOKEN_RE.test(String(args[IDENTITY_PARAM]))) knownGoodToken = args[IDENTITY_PARAM];
      } catch (e) {
        text = `ERROR unavailable: food service not reachable (${e.message})`;
      }
      reply(id, { content: [{ type: 'text', text }], isError: text.startsWith('ERROR') });
    } else if (id !== undefined) {
      replyError(id, -32601, `unknown method ${method}`);
    }
  } catch (e) {
    if (id !== undefined) replyError(id, -32603, e.message);
  }
});
rl.on('close', () => process.exit(0));
