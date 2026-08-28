import puppeteer from '/Users/westbrook/.npm/_npx/0f94ee7615faf582/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
import { mkdirSync, writeFileSync } from 'node:fs';
const OUT = '/tmp/verify-task16';
mkdirSync(OUT + '/shots', { recursive: true });
const CHROME = '/Users/westbrook/.cache/puppeteer/chrome/mac_arm-127.0.6533.119/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = 'file:///Users/westbrook/intent/workspaces/person-create/repo/punisher-game.html?mute=1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function openPage(browser, consoleLog) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 640 });
  page.on('console', m => consoleLog.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => consoleLog.push({ type: 'error', text: String(e.message || e) }));
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction("window.__punisherPlayer && window.__punisherEnemies && window.__punisherFinal", { timeout: 15000 });
  await page.evaluate(() => {
    for (const id of ['overlay','introcard','choice','endcard']) {
      const el = document.getElementById(id); if (el) el.classList.remove('show');
    }
    document.getElementById('overlay')?.classList.add('hidden');
  });
  await sleep(300);
  return page;
}
async function teleport(page, x, y, z, yaw=0, hp=1000) {
  await page.evaluate(({x,y,z,yaw,hp}) => {
    __punisherPlayer.pos.set(x,y,z); __punisherPlayer.vel.set(0,0,0);
    __punisherPlayer.yaw = yaw; __punisherPlayer.health = hp;
  }, {x,y,z,yaw,hp});
}
async function state(page) {
  return await page.evaluate(() => ({
    pos: { x: __punisherPlayer.pos.x, y: __punisherPlayer.pos.y, z: __punisherPlayer.pos.z },
    enemies: __punisherEnemies.list.map(e => ({ type: e.type, zone: e.zone, alive: e.alive, x: e.pos.x, z: e.pos.z })),
    aliveBakery: __punisherEnemies.list.filter(e => e.alive && e.zone === 'bakery').length,
    aliveStreet: __punisherEnemies.list.filter(e => e.alive && e.zone === 'street').length,
    endcard: { shown: document.getElementById('endcard')?.classList.contains('show'),
               tag: document.getElementById('endtag')?.textContent,
               title: document.getElementById('endtitle')?.textContent },
    objective: document.getElementById('objective')?.textContent,
  }));
}

async function walkPath(page, points, msPerHop) {
  // Sweep player through `points` to simulate locomotion so triggersUpdate() sees
  // each intermediate position.
  for (const p of points) {
    await teleport(page, p.x, p.y ?? 1.72, p.z, 0);
    await sleep(msPerHop);
  }
}

async function testA_FastBakeryNoCar(browser) {
  // Fresh page → enter street trigger → walk straight to bakery before 6s prompt.
  const log = [];
  const page = await openPage(browser, log);
  await teleport(page, 0, 1.72, 12);
  await sleep(400);  // street trigger fires
  // Walk west through street then into bakery door.
  await walkPath(page, [
    {x:-5,z:12},{x:-10,z:14},{x:-15,z:16},{x:-18,z:18},
    {x:-19,z:20.1},{x:-19,z:21},{x:-20,z:24},
  ], 250);
  await sleep(900);
  const s = await state(page);
  await page.close();
  return { name: 'A_FastBakery_NoCarCommit', ...s, consoleErr: log.filter(c=>c.type==='error').length };
}

async function testB_BakeryAfterCarCommit(browser) {
  // Enter street → wait 7s for present → walk into car proximity (commits car) →
  // then walk into bakery and verify whether raiders/endcard fire.
  const log = [];
  const page = await openPage(browser, log);
  await teleport(page, 0, 1.72, 12);
  await sleep(400);
  // wait past the 6s present timeout.
  await sleep(6500);
  // approach car (CAR_POS=14,7.5) — within 4.5 → StreetChoice commits to 'car'.
  await walkPath(page, [{x:5,z:11},{x:10,z:9},{x:13,z:8.2}], 300);
  await sleep(500);
  const afterCarCommit = await state(page);
  // Now walk back across street into bakery.
  await walkPath(page, [
    {x:8,z:10},{x:0,z:12},{x:-8,z:14},{x:-14,z:17},
    {x:-19,z:20.1},{x:-19,z:21},{x:-20,z:24},
  ], 250);
  await sleep(2000);
  const afterBakeryEntry = await state(page);
  await page.close();
  return { name: 'B_BakeryAfterCarCommit', afterCarCommit, afterBakeryEntry, consoleErr: log.filter(c=>c.type==='error').length };
}

async function testC_TriggerBoundary(browser) {
  // Probe: does the bakery trigger fire at the door threshold (z=20.0) or only
  // once the player is past z=20.3?
  const log = [];
  const page = await openPage(browser, log);
  await teleport(page, 0, 1.72, 12); await sleep(400);  // fire street first
  const probes = [];
  for (const z of [19.5, 19.9, 20.0, 20.1, 20.2, 20.29, 20.31, 20.5]) {
    // Reset by reloading would lose the state; instead test cumulative: once
    // a single probe fires, log it and break out.
    await teleport(page, -19, 1.72, z); await sleep(300);
    const s = await state(page);
    probes.push({ z, aliveBakery: s.aliveBakery, endcard: s.endcard.shown, obj: s.objective });
    if (s.aliveBakery > 0 || s.endcard.shown) break;
  }
  await page.close();
  return { name: 'C_TriggerBoundary', probes };
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox','--disable-dev-shm-usage','--enable-webgl','--use-gl=angle','--use-angle=metal','--disable-gpu-vsync','--disable-frame-rate-limit'],
    defaultViewport: { width: 1024, height: 640 },
  });
  try {
    const out = {};
    out.A = await testA_FastBakeryNoCar(browser);
    out.B = await testB_BakeryAfterCarCommit(browser);
    out.C = await testC_TriggerBoundary(browser);
    console.log(JSON.stringify(out, null, 2));
    writeFileSync(OUT + '/bakery-repro.json', JSON.stringify(out, null, 2));
  } finally { await browser.close(); }
}
main();

