// One-shot: insert `behavior` blocks into entityRegistry.json for character
// entities. Pure data transform — no schema work, the loader handles
// validation at runtime. Idempotent: skips entries that already have behavior.
//
// Per-entity tuning lives in the BEHAVIORS table below. After running:
//   node scripts/addEnemyBehaviors.mjs
// the loader validates every block at boot; any mismatch (missing anim key,
// out-of-range frame, etc.) throws with a clear message.
import { readFileSync, writeFileSync } from 'node:fs';

const REGISTRY_PATH = 'src/entities/entityRegistry.json';

// type=null => killable but passive (no attack sub-block).
// hurt=true => include hurtAnimation: "take_hit".
// For melee, hitbox is [offsetX, offsetY, width, height].
// For ranged, projectile is [idleAnim, explodeAnim, speed].
const BEHAVIORS = {
  Archer_bandit_spawn: {
    health: 25,
    hurt: false,
    type: 'melee',
    animation: 'attack',
    frame: 10,
    damage: 10,
    range: 100,
    cooldownMs: 2500,
    hitbox: [40, 0, 50, 40],
  },
  Assassin_spawn: {
    health: 15,
    hurt: true,
    type: 'melee',
    animation: 'attack1',
    frame: 2,
    damage: 8,
    range: 50,
    cooldownMs: 1200,
    hitbox: [30, 0, 30, 20],
  },
  Caged_shocker_spawn: {
    health: 25,
    hurt: true,
    type: 'melee',
    animation: 'attack1',
    frame: 3,
    damage: 10,
    range: 50,
    cooldownMs: 1500,
    hitbox: [30, 0, 30, 25],
  },
  Caged_spider_spawn: {
    health: 15,
    hurt: true,
    type: 'melee',
    animation: 'attack',
    frame: 4,
    damage: 8,
    range: 40,
    cooldownMs: 1200,
    hitbox: [15, 0, 25, 15],
  },
  Dark_warden_spawn: {
    health: 40,
    hurt: false,
    type: 'melee',
    animation: 'attack',
    frame: 8,
    damage: 15,
    range: 60,
    cooldownMs: 2000,
    hitbox: [35, 0, 40, 20],
  },
  Evil_crow_spawn: {
    health: 15,
    hurt: false,
    type: 'melee',
    animation: 'attack2',
    frame: 2,
    damage: 8,
    range: 40,
    cooldownMs: 1300,
    hitbox: [20, 0, 25, 20],
  },
  Flame_dude_spawn: {
    health: 25,
    hurt: true,
    type: 'melee',
    animation: 'attack',
    frame: 6,
    damage: 12,
    range: 55,
    cooldownMs: 1800,
    hitbox: [35, 0, 40, 35],
  },
  Ghoul_spawn: {
    health: 20,
    hurt: true,
    type: 'melee',
    animation: 'attack',
    frame: 3,
    damage: 10,
    range: 45,
    cooldownMs: 1500,
    hitbox: [25, 0, 30, 20],
  },
  Hell_bot_spawn: {
    health: 30,
    hurt: true,
    type: 'ranged',
    animation: 'attack1',
    frame: 3,
    damage: 10,
    range: 150,
    cooldownMs: 2000,
    projectile: ['projectile_idle', 'projectile_explode', 300],
  },
  Orb_mage_spawn: {
    health: 25,
    hurt: true,
    type: 'melee',
    animation: 'attack1',
    frame: 6,
    damage: 12,
    range: 60,
    cooldownMs: 1800,
    hitbox: [35, 0, 40, 30],
  },
  Shadow_of_storms_spawn: {
    health: 50,
    hurt: true,
    type: 'melee',
    animation: 'attack1',
    frame: 4,
    damage: 15,
    range: 70,
    cooldownMs: 2000,
    hitbox: [40, 0, 50, 40],
  },
  Spitter_spawn: {
    health: 15,
    hurt: true,
    type: 'ranged',
    animation: 'attack',
    frame: 4,
    damage: 8,
    range: 120,
    cooldownMs: 1800,
    projectile: ['projectile_idle', 'projectile_explode', 250],
  },
  The_blood_king_spawn: {
    health: 100,
    hurt: true,
    type: 'melee',
    animation: 'attack1',
    frame: 9,
    damage: 18,
    range: 60,
    cooldownMs: 2000,
    hitbox: [20, 0, 30, 20],
  },
  The_tarnished_widow_spawn: {
    health: 80,
    hurt: false,
    type: 'melee',
    animation: 'attack',
    frame: 9,
    damage: 15,
    range: 70,
    cooldownMs: 2200,
    hitbox: [40, 0, 50, 45],
  },
  // Killable-passive (no attack animation in registry, kept as Enemy so
  // shots register; Phase 3+ may add ramming behaviors).
  The_hive_spawn: { health: 50, hurt: false, type: null },
  The_heart_hoarder_spawn: { health: 100, hurt: true, type: null },
  Wasp_spawn: { health: 5, hurt: true, type: null },
  Spark_bug_spawn: { health: 5, hurt: false, type: null },
  Crow_spawn: { health: 5, hurt: false, type: null },
};

function buildBehavior(spec) {
  const out = { health: spec.health };
  if (spec.hurt) out.hurtAnimation = 'take_hit';
  if (spec.type === 'melee') {
    const [ox, oy, w, h] = spec.hitbox;
    out.attack = {
      type: 'melee',
      animation: spec.animation,
      frame: spec.frame,
      damage: spec.damage,
      range: spec.range,
      cooldownMs: spec.cooldownMs,
      aggressive: false,
      hitbox: { offsetX: ox, offsetY: oy, width: w, height: h },
    };
  } else if (spec.type === 'ranged' || spec.type === 'magic') {
    const [idle, explode, speed] = spec.projectile;
    out.attack = {
      type: spec.type,
      animation: spec.animation,
      frame: spec.frame,
      damage: spec.damage,
      range: spec.range,
      cooldownMs: spec.cooldownMs,
      aggressive: false,
      projectileAnimIdle: idle,
      projectileAnimExplode: explode,
      projectileSpeed: speed,
    };
  }
  return out;
}

const raw = readFileSync(REGISTRY_PATH, 'utf8');
const reg = JSON.parse(raw);

let added = 0;
let skipped = 0;
const reordered = {};
for (const [id, entry] of Object.entries(reg)) {
  if (!(id in BEHAVIORS)) {
    reordered[id] = entry;
    continue;
  }
  if (entry.behavior) {
    skipped += 1;
    reordered[id] = entry;
    continue;
  }
  // Insert behavior in a stable position: after gravity (if present) and
  // before animations. Recompose the entry preserving key order.
  const next = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'animations') next.behavior = buildBehavior(BEHAVIORS[id]);
    next[k] = v;
  }
  reordered[id] = next;
  added += 1;
}

writeFileSync(REGISTRY_PATH, JSON.stringify(reordered, null, 2) + '\n', 'utf8');
console.log(`addEnemyBehaviors: added=${added}, skipped=${skipped}`);
