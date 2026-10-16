'use strict';
// The window-open allowlist, and the two links in the page that use it: the
// Ko-fi button in the settings panel and the bug-report button in the header.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isAllowedExternal } = require('../../external-links');

function main() {
  assert.strictEqual(isAllowedExternal('https://ko-fi.com/skigim'), true);
  assert.strictEqual(isAllowedExternal('https://www.ko-fi.com/skigim'), true);

  // Same hosts, wrong scheme: a downgrade is not a donation link.
  assert.strictEqual(isAllowedExternal('http://ko-fi.com/skigim'), false);
  // Look-alikes and everything else.
  assert.strictEqual(isAllowedExternal('https://ko-fi.com.example.com/x'), false);
  assert.strictEqual(isAllowedExternal('https://example.com/ko-fi.com'), false);
  assert.strictEqual(isAllowedExternal('https://github.com/Skigim/Ravenswatcher/issues'), true);
  assert.strictEqual(isAllowedExternal('http://github.com/Skigim/Ravenswatcher/issues'), false);
  assert.strictEqual(isAllowedExternal('https://github.com.example.com/x'), false);
  assert.strictEqual(isAllowedExternal('file:///C:/x'), false);
  assert.strictEqual(isAllowedExternal('not a url'), false);

  // The link in the page must be one the handler lets out, or the button is
  // a dead click. Read from the markup so the check follows an href edit.
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'index.html'), 'utf8');
  const m = /<a class="coffee" id="coffee" href="([^"]+)" target="_blank" rel="noopener">/.exec(html);
  assert.ok(m, 'settings panel has no coffee link');
  assert.strictEqual(isAllowedExternal(m[1]), true, `coffee href is not allowed out: ${m[1]}`);

  const b = /<a class="gear" id="bug-report" href="([^"]+)" target="_blank" rel="noopener"/.exec(html);
  assert.ok(b, 'header has no bug-report link');
  assert.strictEqual(isAllowedExternal(b[1]), true, `bug-report href is not allowed out: ${b[1]}`);
  assert.ok(b[1].endsWith('/issues'), `bug-report href does not lead to the issues page: ${b[1]}`);

  console.log('test-external-links: ok');
}

module.exports = { main };
if (require.main === module) main();
