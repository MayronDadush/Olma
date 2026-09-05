'use strict';
// The one static check this codebase runs. Dev-only: the runtime stays at
// two dependencies (pg, resvg), and nothing here reaches the box.
//
// Deliberately narrow — the recommended set plus the two things a test
// suite cannot catch: a variable defined and never read (usually a require
// left behind by a refactor, or a value computed and then not used in the
// branch that mattered), and a reference to a name that does not exist
// (which throws only on the code path that reaches it, i.e. in production).
// Style is not linted; the house style is enforced by reading.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // `_x` says "unused on purpose" (a signature kept for symmetry, a probe
      // argument a render function does not take); `catch {}` with a
      // comment inside is this codebase's way of saying why a failure is
      // swallowed, and `catch (e)` where e is unread is the same statement.
      'no-unused-vars': ['error', {
        args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Both are used on purpose and rarely: a `while (true)` drain loop, a
      // regex that escapes a character the author wanted visibly escaped.
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-useless-escape': 'off',
      // `let x = null; try { x = read() } catch { /* why */ }` is the house
      // idiom for "a thing that could not be read is not a thing in trouble"
      // (CLAUDE.md), and this rule reads the null as a useless assignment.
      'no-useless-assignment': 'off',
      // A rewrapped error deliberately says less than the original (the
      // agent-facing text must not leak internals); `cause` is not wanted.
      'preserve-caught-error': 'off',
      // schedule-card.js strips control characters out of SVG text on purpose.
      'no-control-regex': 'off',
      // Hebrew and vCard/mail fixtures carry non-breaking and zero-width
      // characters inside strings and regexes on purpose; only bare code
      // whitespace is the mistake this rule exists for.
      'no-irregular-whitespace': ['error', { skipStrings: true, skipComments: true, skipRegExps: true, skipTemplates: true }],
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    // Generated and vendored output is not ours to lint.
    ignores: ['node_modules/**', 'graphify-out/**', 'assets/**', 'docs/**'],
  },
];
