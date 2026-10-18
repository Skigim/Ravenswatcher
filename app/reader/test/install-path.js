'use strict';
// Where the game is installed on this machine, for tests that read cooked
// files. Set RAVENSWATCH_INSTALL explicitly to opt in. Normal tests never
// search Steam libraries or open game data.
const fs = require('fs');
const path = require('path');

function findInstall() {
  const env = process.env.RAVENSWATCH_INSTALL;
  if (env) return fs.existsSync(path.join(env, 'Ravenswatch.exe')) ? env : null;
  return null;
}

function cookingDir(install) {
  return path.join(install, 'DarkTalesResources', '_Cooking');
}

module.exports = { findInstall, cookingDir };
