'use strict';
// Per-side, per-feature opt-in on top of an active connection. A connection
// alone enables nothing. Deliberately NOT mutual — my grant says what I allow
// toward me/from me; it never flips anything on the other side.
//
// Feature names validated here in code, not a DB CHECK — adding a category is
// a one-line change, no migration (v1 decision, kept).
const { ok, err } = require('./results');
const audit = require('./audit');

const KNOWN_CONNECTION_FEATURES = ['sharing', 'meetings'];

function isKnownFeature(feature) {
  return KNOWN_CONNECTION_FEATURES.includes(feature);
}

async function memberOfActiveConnection(client, userId, connectionId) {
  const { rows } = await client.query(
    `SELECT * FROM connections WHERE id = $1 AND status = 'active'
       AND (requester_id = $2 OR target_id = $2)`,
    [connectionId, userId]
  );
  return rows[0] || null;
}

async function grantFeature(client, userId, connectionId, feature) {
  if (!isKnownFeature(feature)) return err('invalid', `unknown feature: ${feature}`);
  const conn = await memberOfActiveConnection(client, userId, connectionId);
  if (!conn) return err('not_found', 'active connection not found');
  await client.query(
    `INSERT INTO connection_feature_grants (connection_id, grantor_id, feature)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [connectionId, userId, feature]
  );
  await audit.record(client, userId, 'grant.granted', { connectionId, feature });
  return ok({ connectionId, feature });
}

async function revokeFeatureGrant(client, userId, connectionId, feature) {
  const { rowCount } = await client.query(
    `DELETE FROM connection_feature_grants
     WHERE connection_id = $1 AND grantor_id = $2 AND feature = $3`,
    [connectionId, userId, feature]
  );
  if (!rowCount) return err('not_found', 'grant not found');
  await audit.record(client, userId, 'grant.revoked', { connectionId, feature });
  return ok({ connectionId, feature });
}

async function hasGrant(client, connectionId, grantorId, feature) {
  const { rows } = await client.query(
    `SELECT 1 FROM connection_feature_grants
     WHERE connection_id = $1 AND grantor_id = $2 AND feature = $3`,
    [connectionId, grantorId, feature]
  );
  return Boolean(rows[0]);
}

// The gate every cross-user feature calls before doing anything. Errors
// distinguish "not connected" from "you haven't enabled this" from "they
// haven't enabled this" — the caller always has an actionable next step.
async function requireFeatureBetween(client, actorId, otherUserId, feature) {
  if (!isKnownFeature(feature)) return err('invalid', `unknown feature: ${feature}`);
  const connections = require('./connections');
  const conn = await connections.activeConnectionBetween(client, actorId, otherUserId);
  if (!conn) return err('forbidden', 'not connected', { reason: 'not_connected' });
  if (!(await hasGrant(client, conn.id, actorId, feature))) {
    return err('forbidden', `you have not enabled ${feature} for this connection`, { reason: 'not_granted_by_you', connectionId: conn.id });
  }
  if (!(await hasGrant(client, conn.id, otherUserId, feature))) {
    return err('forbidden', `they have not enabled ${feature} for this connection`, { reason: 'not_granted_by_them', connectionId: conn.id });
  }
  return ok({ connection: conn });
}

async function listGrants(client, userId, connectionId) {
  const conn = await memberOfActiveConnection(client, userId, connectionId);
  if (!conn) return err('not_found', 'active connection not found');
  const { rows } = await client.query(
    `SELECT grantor_id, feature, granted_at FROM connection_feature_grants WHERE connection_id = $1`,
    [connectionId]
  );
  return ok({
    mine: rows.filter((r) => r.grantor_id === userId).map((r) => r.feature),
    theirs: rows.filter((r) => r.grantor_id !== userId).map((r) => r.feature),
  });
}

module.exports = {
  KNOWN_CONNECTION_FEATURES, isKnownFeature,
  grantFeature, revokeFeatureGrant, hasGrant, requireFeatureBetween, listGrants,
};
