import test from 'node:test';
import assert from 'node:assert/strict';

import { controlPage } from '../src/templates/ui.js';

const html = controlPage({ personName: 'JJ' });

test('the custom message field has a status dot before it', () => {
  assert.match(html, /<span class="statusdot" id="textdot"/);
  // Before the input, not after: it reads as a status for the row.
  const dot = html.indexOf('class="statusdot"');
  const input = html.indexOf('<input id="text"');
  assert.ok(dot > -1 && input > -1 && dot < input, 'dot should precede the input');
});

test('the dot is muted by default and green when the message is showing', () => {
  assert.match(html, /\.statusdot \{[^}]*background: var\(--muted\)/);
  assert.match(html, /\.custom\[data-active="true"\] \.statusdot \{ background: var\(--on\)/);
  assert.match(html, /\$\('textrow'\)\.dataset\.active = String\(textOn\)/);
});

test('the dot carries its state for screen readers', () => {
  // Unlike in/out there is no pressed button here, so aria-pressed cannot
  // convey it and the dot has to say so itself.
  assert.match(html, /aria-label="Custom message is not showing"/);
  assert.match(html, /Custom message is showing/);
});

// The switch used var(--fg) when on. In dark mode that is #f2f2f2 against a
// #fff knob - 1.12:1 - so the control looked identical on and off.
test('the switch does not tint its ON state with the foreground colour', () => {
  assert.doesNotMatch(html, /\.toggle\[aria-checked="true"\] \.switch \{ background: var\(--fg\)/);
  assert.match(html, /\.toggle\[aria-checked="true"\] \.switch \{ background: var\(--on\)/);
});

test('--on is defined for both colour schemes', () => {
  const light = html.match(/:root \{ color-scheme[^}]*\}/)[0];
  const dark = html.match(/prefers-color-scheme: dark[\s\S]*?\}\s*\}/)[0];
  assert.match(light, /--on:#[0-9a-f]{6}/i, 'light scheme needs --on');
  assert.match(dark, /--on:#[0-9a-f]{6}/i, 'dark scheme needs --on');
  // Distinct values: one green cannot clear 3:1 on both backgrounds.
  const lv = light.match(/--on:(#[0-9a-f]{6})/i)[1];
  const dv = dark.match(/--on:(#[0-9a-f]{6})/i)[1];
  assert.notEqual(lv.toLowerCase(), dv.toLowerCase());
});

// --- the three options ------------------------------------------------------
// in, out and custom are one set. Custom carries a field, so it cannot be a
// plain button, but it has to read as the same kind of thing rather than a
// form bolted underneath the two that matter.

test('all three options live in one grid', () => {
  assert.match(html, /<div class="options">/);
  assert.match(html, /\.options > \.custom \{ grid-column: 1 \/ -1/);
  // Same card rules for the button and the custom row.
  assert.match(html, /button, \.custom \{/);
});

test('the custom card shows selection the same way the buttons do', () => {
  const pressed = html.match(/button\[aria-pressed="true"\] \{([^}]*)\}/)[1];
  const active = html.match(/\.custom\[data-active="true"\] \{([^}]*)\}/)[1];
  for (const decl of ['background: var(--fg)', 'color: var(--bg)', 'border-color: var(--fg)']) {
    assert.ok(pressed.includes(decl), `button pressed should set ${decl}`);
    assert.ok(active.includes(decl), `custom active should set ${decl}`);
  }
});

test('the action is labelled Show custom and starts inert', () => {
  assert.match(html, /<button id="send" disabled>Show custom<\/button>/);
  // Live only when pressing it would change something.
  assert.match(html, /function syncSend\(\)/);
  assert.match(html, /\$\('send'\)\.disabled = !text \|\| already/);
});

test('the input is bare so the card is the field', () => {
  const rule = html.match(/input\[type=text\] \{([^}]*)\}/)[1];
  assert.ok(rule.includes('border: 0'), 'no border of its own');
  assert.ok(rule.includes('background: transparent'), 'no background of its own');
  assert.doesNotMatch(rule, /border-radius/, 'a box inside a box');
});
