'use strict';
// app/update.js: version parsing, the newer-than comparison, and the one
// launch check with a stubbed fetch. No network.

const assert = require('assert');
const { parseVersion, newerVersion, checkForUpdate, LATEST_URL } = require('../../update');

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function main() {
  // parseVersion: exactly three dotted non-negative integers, optional v.
  assert.deepStrictEqual(parseVersion('0.1.4'), [0, 1, 4]);
  assert.deepStrictEqual(parseVersion('v0.1.4'), [0, 1, 4]);
  assert.deepStrictEqual(parseVersion('10.0.12'), [10, 0, 12]);
  assert.strictEqual(parseVersion('0.1'), null);
  assert.strictEqual(parseVersion('0.1.4-rc1'), null);
  assert.strictEqual(parseVersion('abc'), null);
  assert.strictEqual(parseVersion(''), null);
  assert.strictEqual(parseVersion(undefined), null);

  // newerVersion: numeric, not lexical (0.1.10 > 0.1.9).
  assert.strictEqual(newerVersion('0.1.3', 'v0.1.4'), '0.1.4');
  assert.strictEqual(newerVersion('0.1.9', 'v0.1.10'), '0.1.10');
  assert.strictEqual(newerVersion('0.1.3', 'v1.0.0'), '1.0.0');
  assert.strictEqual(newerVersion('0.1.3', 'v0.1.3'), null);
  assert.strictEqual(newerVersion('0.1.3', 'v0.1.2'), null);
  assert.strictEqual(newerVersion('0.1.3', 'v0.2.0-rc1'), null);
  assert.strictEqual(newerVersion('nope', 'v0.1.4'), null);

  // checkForUpdate: newer release.
  const calls = [];
  const fetchNewer = async (url, opts) => {
    calls.push({ url, opts });
    // html_url is deliberately off-host: the link comes from the tag, not from it.
    return response(200, { tag_name: 'v0.1.4', html_url: 'https://example.com/elsewhere' });
  };
  let r = await checkForUpdate(fetchNewer, '0.1.3');
  assert.deepStrictEqual(r, {
    current: '0.1.3', ok: true, latest: '0.1.4',
    url: 'https://github.com/Skigim/Ravenswatcher/releases/tag/v0.1.4', reason: null,
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, LATEST_URL);
  assert.strictEqual(calls[0].opts.headers.Accept, 'application/vnd.github+json');
  assert.ok(calls[0].opts.signal instanceof AbortSignal, 'a timeout signal is passed');

  // Same version: ok, nothing newer.
  r = await checkForUpdate(async () => response(200, { tag_name: 'v0.1.3', html_url: 'x' }), '0.1.3');
  assert.deepStrictEqual(r, { current: '0.1.3', ok: true, latest: null, url: null, reason: null });

  // A tag without the v prefix links to that tag as spelled.
  r = await checkForUpdate(async () => response(200, { tag_name: '0.1.4' }), '0.1.3');
  assert.strictEqual(r.latest, '0.1.4');
  assert.strictEqual(r.url, 'https://github.com/Skigim/Ravenswatcher/releases/tag/0.1.4');

  // Failures: every one is ok:false with nothing else, plus a reason for the log.
  for (const [label, fetch] of [
    ['404', async () => response(404, { message: 'Not Found' })],
    ['rate limited', async () => response(403, {})],
    ['no tag_name', async () => response(200, { html_url: 'x' })],
    ['unparseable tag', async () => response(200, { tag_name: 'latest', html_url: 'x' })],
    ['body not json', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } })],
    ['rejected', async () => { throw new Error('offline'); }],
  ]) {
    r = await checkForUpdate(fetch, '0.1.3');
    assert.strictEqual(r.ok, false, `${label}: ok`);
    assert.strictEqual(r.latest, null, `${label}: latest`);
    assert.strictEqual(r.url, null, `${label}: url`);
    assert.strictEqual(r.current, '0.1.3', `${label}: current`);
    assert.strictEqual(typeof r.reason, 'string', `${label}: reason`);
  }

  console.log('test-update: ok');
  return 0;
}

module.exports = { main };
if (require.main === module) main().then((f) => process.exit(f), (e) => { console.error(e); process.exit(1); });
