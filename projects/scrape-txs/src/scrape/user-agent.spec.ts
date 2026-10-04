import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromeUserAgent } from './user-agent';

test('chromeUserAgent: reports the launched browser major, never "HeadlessChrome"', () => {
  assert.equal(
    chromeUserAgent('153.0.8010.12'),
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  );
});

test('chromeUserAgent: rejects a version it cannot read a major from', () => {
  assert.throws(() => chromeUserAgent('unknown'), /browser version/);
});
