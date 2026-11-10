// node --test scripts/source-api-cli.test.mjs — argument parsing and hints of the Source API CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseLines, fallbackHint, formatTree } from './source-api.mjs';

test('parseArgs: actions, flags with values/equals, repeated glob, positionals, --', () => {
  const grep = parseArgs(['grep', '--app', 'joy', '--glob', 'packages/scripttag/**,extensions/**', '--glob=docs/**', '--context', '2', '--case', '--json', '--', 'maximum of \\{']);
  assert.equal(grep.action, 'grep'); assert.equal(grep.flags.app, 'joy'); assert.deepEqual(grep.flags.glob, ['packages/scripttag/**', 'extensions/**', 'docs/**']);
  assert.equal(grep.flags.context, '2'); assert.equal(grep.flags.case, true); assert.equal(grep.flags.json, true); assert.deepEqual(grep.positionals, ['maximum of \\{']);
  const search = parseArgs(['search', '--app', 'chatty', 'Suggest reply', 'suggestReply']);
  assert.deepEqual(search.positionals, ['Suggest reply', 'suggestReply']); assert.equal(search.error, undefined);
  assert.equal(parseArgs(['multi_search', '--app', 'joy', 'a']).action, 'multi_search');
  const read = parseArgs(['read', '--app', 'order-limits', '--file', 'extensions/shared-order-limit/src/rule.rs', '--lines', '60-90']);
  assert.equal(read.flags.file, 'extensions/shared-order-limit/src/rule.rs'); assert.equal(read.flags.lines, '60-90');
  assert.equal(parseArgs(['tree', '--app', 'joy', '--path', 'packages/scripttag', '--glob', '*.js']).flags.path, 'packages/scripttag');
  assert.equal(parseArgs(['apps']).action, 'apps');
  assert.equal(parseArgs([]).flags.help, true); assert.equal(parseArgs(['--help']).flags.help, true);
});

test('parseArgs: validation errors', () => {
  assert.match(parseArgs(['grep', '--app', 'joy']).error, /đúng một regex/);
  assert.match(parseArgs(['grep', '--app', 'joy', 'a', 'b']).error, /đúng một regex/);
  assert.match(parseArgs(['grep', 'x']).error, /cần --app/);
  assert.match(parseArgs(['search', '--app', 'joy']).error, /1–10 chuỗi/);
  assert.match(parseArgs(['read', '--app', 'joy']).error, /cần --file/);
  assert.match(parseArgs(['read', '--app', 'joy', '--file', 'a.js', '--lines', 'x']).error, /--lines/);
  assert.match(parseArgs(['grep', '--app', 'joy', '--context', '9', 'x']).error, /--context/);
  assert.match(parseArgs(['grep', '--app', 'joy', '--glob', '../**', 'x']).error, /glob/);
  assert.match(parseArgs(['grep', '--app', 'joy', '--bogus', '1', 'x']).error, /Cờ không hợp lệ/);
  assert.match(parseArgs(['grep', '--app']).error, /Thiếu giá trị/);
  assert.match(parseArgs(['delete']).error, /Action không hợp lệ/);
});

test('parseLines, fallbackHint, formatTree', () => {
  assert.deepEqual(parseLines('100-160'), { start: 100, end: 160 });
  assert.deepEqual(parseLines('50'), { start: 50, end: 249 });
  assert.deepEqual(parseLines(undefined), { start: 1, end: 200 });
  assert.match(fallbackHint('joy', { joy: { commit: 'a05b7566abcdef', fetchedAt: '2026-10-07T04:03:02Z' } }), /apps_doc\/joy \(commit a05b7566, tải 2026-10-07\)/);
  assert.match(fallbackHint('withdrawal-forms', {}), /không có bản sao apps_doc\/withdrawal-forms/);
  const tree = formatTree({ app: 'joy', ageMinutes: 3, commit: '958ffb09abcd', ref: 'master', path: 'packages/scripttag', truncated: false, files: ['a.js', 'b.js'] });
  assert.equal(tree, '[nguồn API: app joy · clone 3 phút · commit 958ffb09 · ref master] 2 mục dưới packages/scripttag\na.js\nb.js');
});
