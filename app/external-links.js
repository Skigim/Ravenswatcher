'use strict';
// Which URLs the readout window may hand to the system browser.
//
// The page has no way to talk to the main process (see preload.js), so a link
// with target="_blank" is the one path a click can take out of the window.
// Electron's default for that is a second BrowserWindow, which is never what
// this app wants. main.js installs a window-open handler that denies every
// request and, for the hosts listed here, opens the URL externally instead.
//
// The list is hosts, not exact URLs, so the Ko-fi and bug-report links in
// web/index.html can change without a second edit here. Anything else --
// including http:// on a listed host -- stays shut.

const EXTERNAL_HOSTS = new Set(['ko-fi.com', 'www.ko-fi.com', 'github.com', 'www.github.com']);

/** True when `url` is an https link to a host the window may open. */
function isAllowedExternal(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && EXTERNAL_HOSTS.has(u.hostname);
}

module.exports = { isAllowedExternal };
