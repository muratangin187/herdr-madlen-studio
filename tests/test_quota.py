"""Quota cards tests: verify 3 provider cards (Claude, Antigravity, Codex) covering 5 windows."""
from pathlib import Path
import subprocess
import unittest


class QuotaTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).resolve().parents[1]
        self.quota_dir = self.root / 'theme' / 'mods' / 'madlen-quota'

    def test_quota_files_exist(self):
        self.assertTrue((self.quota_dir / 'main.js').is_file())
        self.assertTrue((self.quota_dir / 'mod.json').is_file())
        self.assertTrue((self.quota_dir / 'codex.svg').is_file())
        self.assertTrue((self.quota_dir / 'antigravity.svg').is_file())

    def test_quota_main_contains_required_providers_and_windows(self):
        content = (self.quota_dir / 'main.js').read_text()
        self.assertIn('claude,codex,agy', content)
        self.assertIn('antigravity', content)
        self.assertIn('Claude (5 saatlik)', content)
        self.assertIn('Claude (haftalık)', content)
        self.assertIn('Antigravity (5 saatlik)', content)
        self.assertIn('Antigravity (haftalık)', content)
        self.assertIn('Codex (haftalık)', content)

    def test_quota_rendering_in_node(self):
        script = r"""
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const mainJsPath = process.argv[1];
const code = fs.readFileSync(mainJsPath, 'utf8');

class Element {
  constructor(tag) { this.tag = tag; this._children = []; this._props = {}; }
  child(c) { this._children.push(c); return this; }
  children(cs) { this._children.push(...cs); return this; }
  id(id) { this._props.id = id; return this; }
  size(s) { this._props.size = s; return this; }
  size_full() { this._props.sizeFull = true; return this; }
  w_full() { this._props.wFull = true; return this; }
  h_full() { this._props.hFull = true; return this; }
  flex_1() { this._props.flex1 = true; return this; }
  flex_none() { this._props.flexNone = true; return this; }
  relative() { this._props.relative = true; return this; }
  absolute() { this._props.absolute = true; return this; }
  top(v) { this._props.top = v; return this; }
  left(v) { this._props.left = v; return this; }
  h(v) { this._props.h = v; return this; }
  w(v) { this._props.w = v; return this; }
  px(v) { this._props.px = v; return this; }
  py(v) { this._props.py = v; return this; }
  gap(v) { this._props.gap = v; return this; }
  items_center() { this._props.itemsCenter = true; return this; }
  justify_center() { this._props.justifyCenter = true; return this; }
  justify_between() { this._props.justifyBetween = true; return this; }
  rounded(v) { this._props.rounded = v; return this; }
  bg(v) { this._props.bg = v; return this; }
  border_1() { this._props.border1 = true; return this; }
  border_color(v) { this._props.borderColor = v; return this; }
  overflow_hidden() { this._props.overflowHidden = true; return this; }
  text_size(v) { this._props.textSize = v; return this; }
  font_semibold() { this._props.fontSemibold = true; return this; }
  text_color(v) { this._props.textColor = v; return this; }
  tooltip(v) { this._props.tooltip = v; return this; }
  when(cond, fn) { if (cond) fn(this); return this; }
}

const ctx = {
  View: class {},
  div: () => new Element('div'),
  svg: (p) => new Element('svg').id(p),
  h_flex: () => new Element('h_flex'),
  v_flex: () => new Element('v_flex'),
  exec: async () => ({ code: 0, stdout: '{}' }),
  theme: () => ({ border: '#333', foreground: '#fff', muted: '#888', dim: '#555', hover: '#222' }),
  layout: () => ({ id: 'sidebar', size: { px: 320 } }),
  Date, Math, JSON, Number, String, Array, Object, Boolean
};

const stripped = code
  .replace(/^import .*;\n/gm, '')
  .replace('export default class MadlenQuota', 'globalThis.MadlenQuota = class MadlenQuota');

vm.createContext(ctx);
vm.runInContext(stripped, ctx);

const instance = new ctx.MadlenQuota();
instance.data = {
  claude: { windows: [
    { id: 'five_hour', kind: 'session', left: 100, resetsAt: null },
    { id: 'seven_day', kind: 'weekly', left: 1, resetsAt: '2026-11-18T12:00:00.000Z' }
  ]},
  antigravity: { windows: [
    { id: '5h', kind: 'session', left: 100, resetsAt: '2026-11-16T07:00:00.000Z' },
    { id: 'weekly', kind: 'weekly', left: 100, resetsAt: '2026-11-23T00:00:00.000Z' }
  ]},
  codex: { windows: [
    { id: 'weekly', kind: 'weekly', left: 22, resetsAt: '2026-11-17T14:00:00.000Z' }
  ]}
};

const rendered = instance.render();
assert.equal(rendered.tag, 'v_flex');
assert.equal(rendered._children.length, 3, 'Must render 3 provider cards');

const [claudeCard, agyCard, codexCard] = rendered._children;
assert.equal(claudeCard._props.borderColor, '#5C2B27', 'Critical provider card uses alert border');
assert.equal(claudeCard._children[1]._children.length, 2, 'Claude renders 2 window bars');
assert.equal(agyCard._children[1]._children.length, 2, 'Antigravity renders 2 window bars');
assert.equal(codexCard._children[1]._children.length, 1, 'Codex renders 1 window bar');
"""
        res = subprocess.run(['node', '-e', script, str(self.quota_dir / 'main.js')], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr or res.stdout)
