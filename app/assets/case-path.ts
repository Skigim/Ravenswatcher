'use strict';
// Case-insensitive path resolution for the game's install. Names in the game
// data carry the case the developers used, and on a case-sensitive filesystem
// (Linux) the files on disk may not match it. Windows folds case itself, so
// there the path is built as written and the filesystem does the matching.
//
// Each segment is matched against the directory listing, one level at a time.
// A listing is read once per directory and kept for the life of the resolver,
// so a file renamed after its folder was first read still resolves to the old
// name until a new resolver is made.

import * as fs from 'fs';
import * as path from 'path';

export interface CaseResolverOptions {
  platform?: NodeJS.Platform;
}

export class CaseResolver {
  private readonly platform: NodeJS.Platform;
  /** Directory -> what is on disk there. */
  private readonly listings = new Map<string, Listing>();

  constructor(opts: CaseResolverOptions = {}) {
    this.platform = opts.platform ?? process.platform;
  }

  /**
   * The path of `segments` under `root`, with each segment spelled as it is
   * on disk. A segment with no match is appended as given, along with every
   * segment after it, so the caller's own fs call reports the ENOENT.
   */
  resolve(root: string, segments: readonly string[]): string {
    if (this.platform === 'win32') return path.join(root, ...segments);
    let dir = root;
    for (const [i, seg] of segments.entries()) {
      // The listing decides the spelling, not existsSync: a case-insensitive
      // filesystem would accept the wrong case and return it unchanged.
      const listing = this.listing(dir);
      const name = listing?.exact.has(seg) ? seg : listing?.folded.get(seg.toLowerCase());
      if (name === undefined) return path.join(dir, ...segments.slice(i));
      dir = path.join(dir, name);
    }
    return dir;
  }

  private listing(dir: string): Listing | undefined {
    const cached = this.listings.get(dir);
    if (cached) return cached;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return undefined;
    }
    // Sorted so that when two names differ only by case, the first wins the
    // same way on every run.
    const folded = new Map<string, string>();
    for (const name of names.sort()) {
      const key = name.toLowerCase();
      if (!folded.has(key)) folded.set(key, name);
    }
    const listing = { exact: new Set(names), folded };
    this.listings.set(dir, listing);
    return listing;
  }
}

interface Listing {
  /** Every name on disk, as spelled. */
  exact: Set<string>;
  /** Lower-case name -> the name on disk that a case-insensitive match picks. */
  folded: Map<string, string>;
}

export const caseResolver = new CaseResolver();
