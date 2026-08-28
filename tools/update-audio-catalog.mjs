import { readFile, writeFile } from 'node:fs/promises';

// The provenance manifest remains the source of truth. Only playback IDs and
// local paths belong in the game's JavaScript bundle, not license audit data.
const manifest = JSON.parse(await readFile(new URL('../public/assets/audio/manifest.json', import.meta.url), 'utf8'));
const catalog = { version: manifest.version, samples: manifest.samples };
await writeFile(new URL('../src/core/audio-catalog.json', import.meta.url), `${JSON.stringify(catalog, null, 2)}\n`);
process.stdout.write(`Updated ${Object.keys(catalog.samples).length} local audio groups.\n`);
