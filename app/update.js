'use strict';
// One check per launch against the public repo's latest release. Pure on
// purpose: the fetch is a parameter, so the test passes a stub and main.js
// passes Electron's net.fetch. Every failure resolves to ok:false with a
// reason for the log; nothing here throws past checkForUpdate(). The result
// always carries all five fields, so main.js sends it as is.
//
// /releases/latest excludes drafts and prereleases on GitHub's side. The
// request is unauthenticated: 60 per hour per IP, and the app makes one.
//
// The download link is built from the tag rather than read from html_url,
// so it is always a github.com URL that external-links.js lets out.

const LATEST_URL = 'https://api.github.com/repos/Skigim/Ravenswatcher/releases/latest';
const TAG_PAGE = 'https://github.com/Skigim/Ravenswatcher/releases/tag/';
const TIMEOUT_MS = 5000;

/** `0.1.4` or `v0.1.4` -> [0, 1, 4]. Anything else, including a prerelease
 * suffix, is null: the release workflow never publishes one, and refusing
 * to order it is safer than guessing. */
function parseVersion(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(s));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** The tag's plain version when it parses and is newer than `current`
 * under numeric three-part comparison, else null. */
function newerVersion(current, tag) {
  const a = parseVersion(current);
  const b = parseVersion(tag);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return b.join('.');
    if (b[i] < a[i]) return null;
  }
  return null;
}

async function checkForUpdate(fetch, current) {
  const failed = (reason) => ({ current, ok: false, latest: null, url: null, reason });
  let body;
  try {
    const res = await fetch(LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return failed(`status ${res.status}`);
    body = await res.json();
  } catch (err) {
    return failed(err && err.message ? err.message : String(err));
  }
  if (!body || typeof body.tag_name !== 'string') return failed('no tag_name in response');
  if (!parseVersion(body.tag_name)) return failed(`tag ${body.tag_name} is not a version`);
  const latest = newerVersion(current, body.tag_name);
  if (!latest) return { current, ok: true, latest: null, url: null, reason: null };
  return { current, ok: true, latest, url: TAG_PAGE + body.tag_name, reason: null };
}

module.exports = { parseVersion, newerVersion, checkForUpdate, LATEST_URL };
