import { EncounterSchedule } from './encounter-rules.js';
import { createDefenseEncounter, isInsideDefenseArena } from './defense-rules.js';

/** Finite arena survival; all deadlines are driven by the gameplay step. */
export function createDefenseDirector() {
  let services, settings, schedule, counts, baseline;
  let active = false, resolved = false, spawnTimer = 0, objectiveTimer = 0;
  let damageTaken = 0, lastSafe = null, boundaryNotice = 0;

  function restock(wave) {
    const stats = services.stats();
    const performance = {
      damageTaken,
      shots: Math.max(0, stats.shots - (baseline?.shots || 0)),
      hits: Math.max(0, stats.hits - (baseline?.hits || 0)),
      kills: Math.max(0, stats.kills - (baseline?.kills || 0)),
    };
    services.supplies.refill({ arena: settings.arena, wave, difficulty: settings.difficulty, performance });
    baseline = stats;
    damageTaken = 0;
  }

  return {
    init(dependencies) { services = dependencies; },
    start(run) {
      if (!services) throw new Error('Defense services must be initialized before a run');
      settings = run;
      schedule = new EncounterSchedule(createDefenseEncounter(run), { seed: services.nextSeed() });
      counts = services.createCounts(schedule.config);
      active = true;
      resolved = false;
      spawnTimer = objectiveTimer = damageTaken = boundaryNotice = 0;
      lastSafe = { ...services.playerFoot() };
      baseline = services.stats();
      restock(1);
      this.refreshObjective();
    },
    reset() {
      active = resolved = false;
      schedule = settings = counts = baseline = lastSafe = null;
      services?.supplies.clear();
    },
    isActive() { return active; },
    isResolved() { return resolved; },
    recordDamage(amount) { if (active && Number.isFinite(amount)) damageTaken += Math.max(0, amount); },
    containPlayer() {
      if (!active || services.isDead()) return;
      const foot = services.playerFoot();
      if (isInsideDefenseArena(settings.arena, foot)) {
        if (services.isGrounded()) lastSafe = { ...foot };
      } else if (lastSafe) {
        services.returnPlayer(lastSafe);
        if (boundaryNotice <= 0) {
          services.message('HOLD YOUR GROUND · STAY IN THE DEFENSE AREA', 2);
          boundaryNotice = 3;
        }
      }
    },
    refreshObjective() {
      if (!schedule || resolved) return;
      const arena = settings.arena === 'roof' ? 'ROOFTOP' : 'STREET';
      const between = schedule.groups.every(group => group.cleared);
      const wave = Math.min(settings.waves, between ? schedule.waveIndex + 1 : schedule.waveIndex);
      const detail = between
        ? `NEXT WAVE ${wave} / ${settings.waves} · ${Math.max(0, Math.ceil(schedule.timer))}s · FIELD SUPPLIES NEARBY`
        : `WAVE ${wave} / ${settings.waves} · ${counts.total + schedule.pending.length} HOSTILES`;
      services.objective(`${arena} DEFENSE · ${detail}`, { current: schedule.clearedWaves, total: settings.waves });
    },
    update(dt) {
      if (!active || resolved || services.isDead() || !Number.isFinite(dt) || dt <= 0) return;
      boundaryNotice = Math.max(0, boundaryNotice - dt);
      const key = 'defense-' + settings.arena;
      services.countEnemies(settings.arena, key, counts);
      counts.footY = services.playerFoot().y;
      counts.grounded = services.isGrounded();
      const events = schedule.update(dt, counts);
      if (schedule.cleared) {
        active = false;
        resolved = true;
        services.onWin(this.snapshot());
        return;
      }
      if (events.clearedWaves.length) {
        restock(schedule.waveIndex + 1);
        services.message(`WAVE ${schedule.clearedWaves} CLEARED · WALK OVER FIELD SUPPLIES TO RESTOCK`, 3);
      }
      if (events.queuedWave !== null) spawnTimer = 0;
      spawnTimer -= dt;
      if (schedule.pending.length && spawnTimer <= 0) {
        services.spawn(key, settings.arena, schedule, counts);
        spawnTimer = 0.65;
      }
      services.supplies.update(dt);
      objectiveTimer -= dt;
      if (objectiveTimer <= 0) { this.refreshObjective(); objectiveTimer = 0.25; }
    },
    snapshot() {
      return {
        active, resolved, arena: settings?.arena ?? null, difficulty: settings?.difficulty ?? null,
        wave: schedule?.waveIndex ?? 0, wavesTotal: settings?.waves ?? 0,
        wavesSurvived: schedule?.clearedWaves ?? 0,
        pending: schedule?.pending.length ?? 0, alive: counts?.total ?? 0,
        totalContacts: schedule?.total ?? 0, spawned: schedule?.spawned ?? 0,
        timer: schedule?.timer ?? 0, supplies: services?.supplies.snapshot() ?? null,
      };
    },
  };
}

export const DefenseDirector = createDefenseDirector();
