import assert from 'node:assert/strict';
import { test } from 'node:test';
import { docNoFromRef, parseYnabMemo } from './memo';

test('parseYnabMemo: text ref with bare doc number', () => {
  assert.equal(parseYnabMemo('ref: 276226; desc: TAMARINDOS; auto: 1').ref, '276226');
});

test('parseYnabMemo: json ref (dated)', () => {
  const parsed = parseYnabMemo('{"ref":"20240226_174848","desc":"PedidosYa PROPINAS  GT"}');
  assert.equal(parsed.ref, '20240226_174848');
  assert.equal(parsed.desc, 'PedidosYa PROPINAS  GT');
});

test('parseYnabMemo: non-ref memo yields empty ref', () => {
  assert.equal(parseYnabMemo('Entered automatically by YNAB').ref, '');
});

test('parseYnabMemo: text ref (dated) + desc', () => {
  const parsed = parseYnabMemo('ref: 20240326_140540; desc: MIPAGO CLARO RECURRENC GT;');
  assert.equal(parsed.ref, '20240326_140540');
  assert.equal(parsed.desc, 'MIPAGO CLARO RECURRENC GT');
});

test('parseYnabMemo: null/undefined/empty', () => {
  assert.deepEqual(parseYnabMemo(null), { ref: '', desc: '' });
  assert.deepEqual(parseYnabMemo(undefined), { ref: '', desc: '' });
  assert.deepEqual(parseYnabMemo(''), { ref: '', desc: '' });
});

test('parseYnabMemo: bare numeric memo does not throw, yields empty ref', () => {
  // "276226" is valid JSON (a number) but not an object; must not throw and must not set ref.
  assert.equal(parseYnabMemo('276226').ref, '');
});

test('docNoFromRef: dated ref', () => {
  assert.equal(docNoFromRef('20240326_140540'), '140540');
});

test('docNoFromRef: bare doc number', () => {
  assert.equal(docNoFromRef('276226'), '276226');
});

test('docNoFromRef: strips (n) collision suffix', () => {
  assert.equal(docNoFromRef('20240326_140540(2)'), '140540');
  assert.equal(docNoFromRef('276226(3)'), '276226');
});

test('docNoFromRef: empty ref -> null', () => {
  assert.equal(docNoFromRef(''), null);
});
