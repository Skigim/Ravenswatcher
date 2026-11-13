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

export const LATEST_URL = 'https://api.github.com/repos/Skigim/Ravenswatcher/releases/latest';
const TAG_PAGE = 'https://github.com/Skigim/Ravenswatcher/releases/tag/';
const TIMEOUT_MS = 5000;

export interface UpdateCheck {
  current: string;
  ok: boolean;
  latest: string | null;
  url: string | null;
  reason: string | null;
}

/** The subset of fetch this module calls. Electron's net.fetch satisfies it. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function messageOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err && err.message) return String(err.message);
  return String(err);
}

function hasTagName(x: unknown): x is { tag_name: string } {
  return typeof x === 'object' && x !== null && 'tag_name' in x && typeof x.tag_name === 'string';
}

/** `0.1.4` or `v0.1.4` -> [0, 1, 4]. Anything else, including a prerelease
 * suffix, is null: the release workflow never publishes one, and refusing
 * to order it is safer than guessing. */
export function parseVersion(s: unknown): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(s));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** The tag's plain version when it parses and is newer than `current`
 * under numeric three-part comparison, else null. */
export function newerVersion(current: unknown, tag: unknown): string | null {
  const a = parseVersion(current);
  const b = parseVersion(tag);
  if (!a || !b) return null;
  const [a0, a1, a2] = a;
  const [b0, b1, b2] = b;
  if (b0 > a0) return b.join('.');
  if (b0 < a0) return null;
  if (b1 > a1) return b.join('.');
  if (b1 < a1) return null;
  if (b2 > a2) return b.join('.');
  return null;
}

export async function checkForUpdate(fetch: FetchLike, current: string): Promise<UpdateCheck> {
  const failed = (reason: string): UpdateCheck => ({ current, ok: false, latest: null, url: null, reason });
  let body: unknown;
  try {
    const res = await fetch(LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return failed(`status ${res.status}`);
    body = await res.json();
  } catch (err) {
    return failed(messageOf(err));
  }
  if (!hasTagName(body)) return failed('no tag_name in response');
  if (!parseVersion(body.tag_name)) return failed(`tag ${body.tag_name} is not a version`);
  const latest = newerVersion(current, body.tag_name);
  if (!latest) return { current, ok: true, latest: null, url: null, reason: null };
  return { current, ok: true, latest, url: TAG_PAGE + body.tag_name, reason: null };
}
