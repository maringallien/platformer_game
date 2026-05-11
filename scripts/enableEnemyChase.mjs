#!/usr/bin/env node
// One-shot batch edit: flips `aggressive: false` → true and adds chaseRange /
// moveSpeed / walkAnimation to every melee, non-immovable enemy in the entity
// registry. Ranged enemies (Hell_bot, Spitter) stay stationary on purpose —
// chasing a target makes them less useful as ranged. Immovable enemies (cages,
// The_hive, The_heart_hoarder) can't chase by construction. Idempotent: re-
// running with the same fields is a no-op since the validator accepts the
// same shape we wrote previously.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = resolve(__dirname, '../src/entities/entityRegistry.json');

// Per-enemy chase tuning. walkAnimation must match a key in that entity's
// `animations` map (the registry validator will throw at boot otherwise).
// Speed is in px/s; the player runs at 120 (PLAYER_RUN_SPEED) so 60 lets the
// player out-run a chaser, 80 makes the chase feel pressing, 90 makes bosses
// genuinely threatening.
const CHASE = {
  Archer_bandit_spawn: { chaseRange: 220, moveSpeed: 60, walkAnimation: 'run' },
  Assassin_spawn: { chaseRange: 220, moveSpeed: 70, walkAnimation: 'run' },
  Dagger_bandit_spawn: { chaseRange: 220, moveSpeed: 70, walkAnimation: 'run' },
  Dark_warden_spawn: { chaseRange: 220, moveSpeed: 60, walkAnimation: 'walk' },
  Doberman_spawn: { chaseRange: 220, moveSpeed: 80, walkAnimation: 'run' },
  Evil_crow_spawn: { chaseRange: 220, moveSpeed: 70, walkAnimation: 'walk1' },
  Flame_dude_spawn: { chaseRange: 220, moveSpeed: 60, walkAnimation: 'walk' },
  Ghoul_spawn: { chaseRange: 220, moveSpeed: 60, walkAnimation: 'walk' },
  Orb_mage_spawn: { chaseRange: 240, moveSpeed: 55, walkAnimation: 'walk' },
  Shadow_of_storms_spawn: { chaseRange: 280, moveSpeed: 80, walkAnimation: 'run' },
  The_blood_king_spawn: { chaseRange: 300, moveSpeed: 90, walkAnimation: 'run' },
  The_tarnished_widow_spawn: { chaseRange: 280, moveSpeed: 70, walkAnimation: 'walk' },
};

const raw = readFileSync(REGISTRY_PATH, 'utf-8');
const data = JSON.parse(raw);

let mutated = 0;
const skipped = [];

for (const [id, chase] of Object.entries(CHASE)) {
  const entry = data[id];
  if (!entry) {
    skipped.push(`${id}: not in registry`);
    continue;
  }
  const attack = entry.behavior?.attack;
  if (!attack) {
    skipped.push(`${id}: no attack block`);
    continue;
  }
  if (!(chase.walkAnimation in entry.animations)) {
    skipped.push(
      `${id}: walkAnimation "${chase.walkAnimation}" not in animations [${Object.keys(entry.animations).join(', ')}]`,
    );
    continue;
  }
  attack.aggressive = true;
  attack.chaseRange = chase.chaseRange;
  attack.moveSpeed = chase.moveSpeed;
  attack.walkAnimation = chase.walkAnimation;
  mutated += 1;
}

writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');

console.log(`Updated ${mutated} enemies.`);
if (skipped.length > 0) {
  console.warn('Skipped:');
  for (const s of skipped) console.warn(`  - ${s}`);
}
