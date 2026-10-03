'use strict';
// The seven game-night tools as the model sees them. No requires on purpose:
// the gateway spawns bin/games-mcp.js on every turn of every agent that is
// shown them, and tools/list must not pay for pg or the store.
//
// Shown to NOBODY until a person has the pack: every gateway agent carries
// `games__*` in its deny list (olma2/src/intake/agent-tool-policy.js), and
// gamesd refuses a call from anybody without 'games' in their packs
// (src/tools.js). The same limits as Olma's own schemas: `olma_identity`
// first and required, every description under 700 characters.
const IDENTITY_PARAM = 'olma_identity';

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const CODE = S('string', 'Only when told there are two open nights: the 5-letter code of the one they mean.');

const def = (name, description, props, required = []) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: { [IDENTITY_PARAM]: S('string', 'from AGENTS.md'), ...props },
    required: [IDENTITY_PARAM, ...required],
  },
});

const TOOL_DEFS = [
  def('start_game_night',
    'Open a poker night with the person as host and get its shared page link and join code. Only when they ask to start one. Ask the buy-in price and chips per buy-in if they did not say. Players can be added now or later.',
    {
      price: S('number', 'Buy-in price in shekels.'),
      chips: S('integer', 'Chips per buy-in.'),
      name: S('string', 'Name of the night, if they gave one.'),
      players: S('array', 'Other players\' names, as they wrote them.', { items: { type: 'string' } }),
    }, ['price', 'chips']),
  def('add_buyin',
    'Record a buy-in ("עוד כניסה", "+1", "חצי כניסה") for the person or for a named player, or cancel the last one with cancel:true. A name not yet at the table is added. Returns their count.',
    {
      n: S('number', '1 for a buy-in, 0.5 for a half. Default 1.', { enum: [1, 0.5] }),
      player: S('string', 'Another player\'s name. Omit for the person themselves.'),
      cancel: S('boolean', 'true to remove that player\'s last buy-in instead.'),
      night_code: CODE,
    }),
  def('my_game_status',
    'Where the person stands in tonight\'s night: buy-ins, what they cost, chips reported, and the page link. For "בכמה כניסות אני?" and the like.',
    { night_code: CODE }),
  def('report_chips',
    'Record the chips a player ends with ("נשארו לי 1,850"). When everyone has reported, returns whether the count closes, or how many chips are missing or extra and who has not reported. When it closes, the settlement is sent to the players as its own message and the result says so; relay a `text` only if the result carries one, exactly as given.',
    {
      chips: S('integer', 'Chips left at the end.'),
      player: S('string', 'Another player\'s name. Omit for the person themselves.'),
      night_code: CODE,
    }, ['chips']),
  def('add_food_order',
    'Record a food order paid during the night. Without eaters it saves nothing and returns the players, so ask who ate and call again with them. Payer defaults to the person.',
    {
      what: S('string', 'What was ordered, in their words.'),
      amount: S('number', 'Total paid, in shekels.'),
      eaters: S('array', 'Names of everyone who ate from it, the payer included if they ate.', { items: { type: 'string' } }),
      payer: S('string', 'Who paid, if not the person.'),
      night_code: CODE,
    }, ['what', 'amount']),
  def('close_game_night',
    'Close the person\'s open night WITHOUT a settlement, when they ask to close or cancel it and the chips will not be counted: they changed their minds, stopped early, or opened it by mistake. It is final, so it takes two calls: the first only returns what is on the table and a question to ask them; call again with confirm:true only after they say yes. Nothing is calculated or sent. If they want the settlement instead, use report_chips. To open a new night after this, call start_game_night.',
    {
      confirm: S('boolean', 'true only on the second call, after they said yes to closing it.'),
      night_code: CODE,
    }),
  def('game_night_summary',
    'The night\'s settlement as a ready text to paste in the group: who transfers to whom, fewest transfers. Relay its `text` exactly as given.',
    { night_code: CODE }),
];

module.exports = { TOOL_DEFS, IDENTITY_PARAM };
