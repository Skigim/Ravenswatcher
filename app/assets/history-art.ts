// History art uses the same cooked resources and private icon cache as the shop.
import * as fs from 'fs';
import { createHash } from 'crypto';
import { cookedPath, listCooked, readCooked } from './tables';

export interface HistoryArtTables {
  HERO_ICONS: Record<string, string>;
  DIFFICULTY_ICONS: Record<string, string>;
  TALENT_ICONS: Record<string, Record<string, string>>;
}

/** Named serialized component boundaries, including the exact length of each name. */
function components(blob: Buffer): { start: number; end: number; name: string }[] {
  const marker = Buffer.from([0x22, 0x22, 0xbb, 0xaa]);
  const records: { start: number; end: number; name: string }[] = [];
  for (let at = blob.indexOf(marker); at !== -1; at = blob.indexOf(marker, at + 4)) {
    const lengthAt = at + 20;
    if (lengthAt + 4 > blob.length) continue;
    const length = blob.readUInt32LE(lengthAt);
    if (!length || length > 256 || lengthAt + 4 + length > blob.length) continue;
    const name = blob.toString('latin1', lengthAt + 4, lengthAt + 4 + length);
    if (/^[\x20-\x7e]+$/.test(name)) records.push({ start: at, end: lengthAt + 4 + length, name });
  }
  return records;
}

export function buildHistoryArt(cookingDir: string): {
  tables: HistoryArtTables; rows: { asset: string; uiPath: string }[];
} {
  const tables: HistoryArtTables = { HERO_ICONS: {}, DIFFICULTY_ICONS: {}, TALENT_ICONS: {} };
  const assets = new Map<string, string>();
  const heroOwners = new Map<string, string>();
  const add = (uiPath: string): string => {
    const asset = 'history_' + createHash('sha256').update(uiPath).digest('hex').slice(0, 20) + '.png';
    assets.set(uiPath, asset);
    return asset;
  };
  const files = (dir: string): string[] => fs.existsSync(cookedPath(cookingDir, dir)) ? listCooked(cookingDir, dir) : [];
  for (const file of files('Definitions/Heroes')) {
    if (!file.endsWith('.herodef.ot.DtHeroDefinition.gen')) continue;
    const hero = file.split('.')[0]?.replace(/_Update\d+$/i, '');
    if (!hero) continue;
    const blob = readCooked(cookingDir, `Definitions/Heroes/${file}`).toString('latin1');
    // Definition codes and entity owners can differ (for example underscores).
    const owner = /Heroes\\(Hero_[A-Za-z0-9_]+)\\/.exec(blob)?.[1];
    if (owner) heroOwners.set(owner, hero);
    const portraits = [...new Set(blob.match(/Heroes\\[A-Za-z0-9_]+\\Portrait_[A-Za-z0-9_]+\.png/g) ?? [])]
      .filter(p => !/_Highlight\.png$/.test(p));
    if (portraits.length === 1 && portraits[0]) tables.HERO_ICONS[hero] = add(portraits[0].replace(/\\/g, '/'));
  }
  for (const file of files('EntitySettings/Heroes')) {
    const match = /^(Hero_[^!]+)!\1\.entity\.ot\.EntitySettingsResource\.gen$/.exec(file);
    if (!match?.[1]) continue;
    const hero = heroOwners.get(match[1]) ?? match[1].slice(5).replace(/_Update\d+$/i, '');
    const blob = readCooked(cookingDir, `EntitySettings/Heroes/${file}`);
    const records = components(blob);
    const icons: Record<string, string> = {};
    records.forEach((record, i) => {
      if (!record.name.startsWith('Skill Controller ')) return;
      const end = records[i + 1]?.start ?? blob.length;
      const paths = [...new Set(blob.toString('latin1', record.end, end)
        .match(/Heroes\\[A-Za-z0-9_\\ .!-]+\.png/g) ?? [])].filter(p => !/_Disabled\.png$/.test(p));
      if (paths.length === 1 && paths[0]) {
        const asset = add(paths[0].replace(/\\/g, '/'));
        if (icons[record.name] && icons[record.name] !== asset) throw new Error(`${hero}: ambiguous art for ${record.name}`);
        icons[record.name] = asset;
      }
    });
    tables.TALENT_ICONS[hero] = icons;
  }
  for (let d = 0; d <= 3; d++) {
    const uiPath = `Common/Difficulty Icons/Icon_NewDifficulty_${d}.png`;
    if (fs.existsSync(cookedPath(cookingDir, `Ui/Common/Difficulty Icons!Icon_NewDifficulty_${d}.png.Texture.dxt`))) {
      tables.DIFFICULTY_ICONS[d] = add(uiPath);
    }
  }
  return { tables, rows: [...assets].map(([uiPath, asset]) => ({ asset, uiPath })) };
}
