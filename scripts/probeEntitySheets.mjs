#!/usr/bin/env node
// Builds src/entities/entityRegistry.json from the authoritative DarkSpriteLib
// registry at ~/Documents/DarkSpriteLib/registry/registry.json. The
// authoritative registry has correct frame metadata (frameWidth/frameHeight/
// frameCount/anchorX/anchorY/loops) for every animation — copying it directly
// avoids the guess-frames-from-PNG-dimensions heuristic that produced
// wrong-sized frames for non-square or non-strip layouts.
//
// Mapping rules per LDtk identifier:
//   - kind 'all':    pull every animation from the named registry entry.
//                    Used for characters and animals whose entity entry has
//                    a complete idle/walk/death/etc. set.
//   - kind 'pick':   pull one specific animation from a grouped registry
//                    entry (e.g. objects.general.traps.bear_trap_animation1).
//                    The picked anim's name becomes the entity's
//                    defaultAnimation; the entity has just that one anim.
//
// Re-run this script after adding new LDtk entity types or new sprite
// folders. It overwrites entityRegistry.json — hand-tuned values get
// regenerated.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const REGISTRY_OUT = join(REPO_ROOT, 'src', 'entities', 'entityRegistry.json');
const REPORT_OUT = join(REPO_ROOT, 'scripts', 'probeEntitySheets.report.txt');

// Authoritative source. Points outside this repo to the DarkSpriteLib repo
// the user maintains the resizer in. If that repo moves, override via env.
const AUTH_REGISTRY_PATH =
  process.env.DARK_SPRITE_LIB_REGISTRY ??
  resolve(REPO_ROOT, '..', 'DarkSpriteLib', 'registry', 'registry.json');

// Path prefix added to every animation `file` so the runtime loader resolves
// the path against /public/DarkSpriteLib/...
const RUNTIME_FILE_PREFIX = 'DarkSpriteLib/';

// LDtk identifier → authoritative-registry source description.
//
//   kind: 'all'   — copy every animation from the entity
//   kind: 'pick'  — copy one named animation (multi-prop registry entries)
//
// `at` is a dotted path into registry.json, with three top-level sections:
//   characters.<id>
//   animals.<id>
//   objects.<biome>.objects.<entity>
//
// Animals default to the _blue color variant where multiple exist.
// Objects with grouped animations (traps, sci-fi_chests, shops, custom_fires)
// use 'pick' so one LDtk identifier resolves to one specific animation.
const MAPPING = Object.freeze({
  // Characters (all animations included)
  Archer_bandit_spawn: { kind: 'all', at: 'characters.archer_bandit' },
  Assassin_spawn: { kind: 'all', at: 'characters.assassin' },
  Caged_shocker_spawn: { kind: 'all', at: 'characters.caged_shocker' },
  Caged_spider_spawn: { kind: 'all', at: 'characters.caged_spider' },
  Dagger_bandit_spawn: { kind: 'all', at: 'characters.dagger_bandit' },
  Dark_warden_spawn: { kind: 'all', at: 'characters.the_dark_warden' },
  Doberman_spawn: { kind: 'all', at: 'characters.doberman' },
  Evil_crow_spawn: { kind: 'all', at: 'characters.evil_crow' },
  Flame_dude_spawn: { kind: 'all', at: 'characters.flame_dude' },
  Ghoul_spawn: { kind: 'all', at: 'characters.ghoul' },
  Hell_bot_spawn: { kind: 'all', at: 'characters.hell_bot' },
  Mushroom_merchant_spawn: { kind: 'all', at: 'characters.mushroom_merchant' },
  Orb_mage_spawn: { kind: 'all', at: 'characters.orb_mage' },
  Shadow_of_storms_spawn: { kind: 'all', at: 'characters.shadow_of_storms' },
  Spark_bug_spawn: { kind: 'all', at: 'characters.spark_bug' },
  Spitter_spawn: { kind: 'all', at: 'characters.spitter' },
  The_blood_king_spawn: { kind: 'all', at: 'characters.the_blood_king' },
  The_heart_hoarder_spawn: { kind: 'all', at: 'characters.the_heart_hoarder' },
  The_hive_spawn: { kind: 'all', at: 'characters.the_hive' },
  The_tarnished_widow_spawn: { kind: 'all', at: 'characters.the_tarnished_widow' },
  Wasp_spawn: { kind: 'all', at: 'characters.wasp' },

  // Animals (blue variant for each species)
  Crow_spawn: { kind: 'all', at: 'animals.crow_blue' },
  Deer_spawn: { kind: 'all', at: 'animals.deer_blue' },
  Elk_spawn: { kind: 'all', at: 'animals.elk_blue' },
  Fox_spawn: { kind: 'all', at: 'animals.fox_blue' },

  // Objects — full sets where the entity carries multiple anims
  Portal_spawn: { kind: 'all', at: 'objects.the_beneath.objects.portal' },
  Save_spawn: { kind: 'all', at: 'objects.the_beneath.objects.save' },
  Door_spawn: {
    kind: 'pick',
    at: 'objects.the_beneath.objects.door_open_idle',
    anim: 'door_open_idle',
  },
  Light_with_bugs_spawn: {
    kind: 'pick',
    at: 'objects.the_beneath.objects.light_with_bugs_idle',
    anim: 'light_with_bugs_idle',
  },

  // Objects — pick one animation out of a grouped entity
  Bear_trap_spawn: {
    kind: 'pick',
    at: 'objects.general.objects.traps',
    anim: 'bear_trap_animation1',
  },
  Shocker_ejector_spawn: {
    kind: 'pick',
    at: 'objects.general.objects.traps',
    anim: 'shokcer_ejector',
  },
  Smoke_flame_ejector_red_spawn: {
    kind: 'pick',
    at: 'objects.general.objects.traps',
    anim: 'smoke_flame_ejector_red',
  },
  Spike_ejector_spawn: {
    kind: 'pick',
    at: 'objects.general.objects.traps',
    anim: 'spike_ejector',
  },
  Spikes_spawn: {
    kind: 'pick',
    at: 'objects.general.objects.traps',
    anim: 'spikes',
  },
  Swaying_sword_spawn: {
    kind: 'pick',
    at: 'objects.general.objects.traps',
    anim: 'swaying_sword_animation1',
  },
  Sword_slicer_spawn: {
    kind: 'pick',
    at: 'objects.general.objects.traps',
    anim: 'sword_slicer',
  },
  Chest_2_1_spawn: {
    kind: 'pick',
    at: 'objects.general.objects.sci-fi_chests',
    anim: 'chest_2.1',
  },
  Chest_5_1_spawn: {
    kind: 'pick',
    at: 'objects.general.objects.sci-fi_chests',
    anim: 'chest_5.1',
  },
  Tech_shop_spawn: {
    kind: 'pick',
    at: 'objects.general.objects.shops',
    anim: 'tech_shop',
  },
  Rock_orange_mild_spawn: {
    kind: 'pick',
    at: 'objects.general.objects.custom_fires',
    anim: 'rock_orange_mild',
  },

  // Intentionally unmapped (no asset match or handled elsewhere)
  Hanger_dude_1_spawn: null,
  Hanger_dude_2_spawn: null,
  Statue1_spawn: null,
  Sword_master_spawn: null,
});

function getAtPath(obj, dotted) {
  // Custom split that respects keys containing '-' so 'sci-fi_chests' isn't
  // mistakenly split. Simple split on '.' is enough for our paths.
  const parts = dotted.split('.');
  let cursor = obj;
  for (const p of parts) {
    if (cursor == null || typeof cursor !== 'object') return null;
    cursor = cursor[p];
  }
  return cursor ?? null;
}

function listLdtkSpawnIdentifiers() {
  const raw = readFileSync(join(REPO_ROOT, 'the_beneath.ldtk'), 'utf8');
  const project = JSON.parse(raw);
  const set = new Set();
  for (const def of project.defs?.entities ?? []) {
    if (typeof def.identifier === 'string' && def.identifier.endsWith('_spawn')) {
      set.add(def.identifier);
    }
  }
  return Array.from(set).sort();
}

function buildAnimEntry(authAnim) {
  // The authoritative shape nests frame metadata under `frames`. We flatten
  // it into the runtime registry's per-anim shape and translate the file
  // path so the runtime loader points at /public/DarkSpriteLib/...
  const frames = authAnim.frames ?? {};
  return {
    file: `${RUNTIME_FILE_PREFIX}${authAnim.file}`,
    frameWidth: frames.frameWidth,
    frameHeight: frames.frameHeight,
    frameCount: frames.frameCount,
    loops: authAnim.loops !== false,
    ...(frames.anchorX !== undefined ? { anchorX: frames.anchorX } : {}),
    ...(frames.anchorY !== undefined ? { anchorY: frames.anchorY } : {}),
    ...(frames.displayScale !== undefined
      ? { displayScale: frames.displayScale }
      : {}),
  };
}

function deriveBodyDimensions(frameWidth, frameHeight) {
  // Heuristic: body is roughly half the frame, clamped to a sane range.
  // Real per-entity tuning lands later when collision/AI ships.
  const FRACTION = 0.5;
  const MIN = 6;
  const MAX_W = 48;
  const MAX_H = 48;
  return {
    width: Math.max(MIN, Math.min(MAX_W, Math.round(frameWidth * FRACTION))),
    height: Math.max(MIN, Math.min(MAX_H, Math.round(frameHeight * FRACTION))),
  };
}

function pickDefaultAnimationKey(animKeys) {
  return (
    animKeys.find((k) => k === 'idle') ??
    animKeys.find((k) => k === 'fly') ??
    animKeys.find((k) => k === 'walk') ??
    animKeys[0]
  );
}

function main() {
  if (!existsSync(AUTH_REGISTRY_PATH)) {
    throw new Error(
      `Authoritative registry not found at ${AUTH_REGISTRY_PATH}. ` +
        'Set DARK_SPRITE_LIB_REGISTRY env var to its real path.',
    );
  }
  const auth = JSON.parse(readFileSync(AUTH_REGISTRY_PATH, 'utf8'));
  const identifiers = listLdtkSpawnIdentifiers();

  const out = {};
  const skipped = [];
  const unmapped = [];
  const errors = [];

  for (const id of identifiers) {
    if (!(id in MAPPING)) {
      unmapped.push(id);
      continue;
    }
    const m = MAPPING[id];
    if (m === null) {
      skipped.push(id);
      continue;
    }
    const source = getAtPath(auth, m.at);
    if (!source || !source.animations) {
      errors.push(`${id}: authoritative path "${m.at}" not found or has no animations`);
      continue;
    }
    let animations;
    let defaultAnimation;
    let defaultFrameWidth;
    let defaultFrameHeight;
    if (m.kind === 'all') {
      // Skip sequence-type anims — those compose multiple simple anims
      // via a `parts` array and have no top-level file/frames. The
      // component simple anims (e.g. teleport_appear, teleport_vanish)
      // are exposed as siblings with their own keys, so dropping the
      // sequence wrapper loses nothing the runtime can play directly.
      const simpleEntries = Object.entries(source.animations).filter(
        ([, a]) => a && a.type === 'simple',
      );
      const entries = simpleEntries.map(([animKey, authAnim]) => [
        animKey,
        buildAnimEntry(authAnim),
      ]);
      if (entries.length === 0) {
        errors.push(`${id}: "${m.at}" has no simple-type animations`);
        continue;
      }
      animations = Object.fromEntries(entries);
      defaultAnimation = pickDefaultAnimationKey(entries.map(([k]) => k));
      const def = animations[defaultAnimation];
      defaultFrameWidth = def.frameWidth;
      defaultFrameHeight = def.frameHeight;
    } else if (m.kind === 'pick') {
      const authAnim = source.animations[m.anim];
      if (!authAnim) {
        errors.push(`${id}: anim "${m.anim}" not in "${m.at}".animations`);
        continue;
      }
      if (authAnim.type !== 'simple') {
        errors.push(
          `${id}: anim "${m.anim}" in "${m.at}" is type="${authAnim.type}", expected "simple"`,
        );
        continue;
      }
      const entry = buildAnimEntry(authAnim);
      animations = { [m.anim]: entry };
      defaultAnimation = m.anim;
      defaultFrameWidth = entry.frameWidth;
      defaultFrameHeight = entry.frameHeight;
    } else {
      errors.push(`${id}: unknown mapping kind "${m.kind}"`);
      continue;
    }
    out[id] = {
      defaultAnimation,
      physicsBody: deriveBodyDimensions(defaultFrameWidth, defaultFrameHeight),
      gravity: false,
      animations,
    };
  }

  writeFileSync(REGISTRY_OUT, JSON.stringify(out, null, 2) + '\n');

  const lines = [];
  lines.push(`Probe ran ${new Date().toISOString()}`);
  lines.push(`Source: ${AUTH_REGISTRY_PATH}`);
  lines.push(`Total LDtk *_spawn identifiers: ${identifiers.length}`);
  lines.push(`Resolved (written): ${Object.keys(out).length}`);
  lines.push(`Skipped (mapping = null): ${skipped.length}`);
  lines.push(`Unmapped (not in MAPPING): ${unmapped.length}`);
  lines.push(`Errors: ${errors.length}`);
  lines.push('');
  if (skipped.length > 0) {
    lines.push('Skipped — intentional:');
    for (const id of skipped) lines.push(`  - ${id}`);
    lines.push('');
  }
  if (unmapped.length > 0) {
    lines.push('Unmapped — add to MAPPING:');
    for (const id of unmapped) lines.push(`  - ${id}`);
    lines.push('');
  }
  if (errors.length > 0) {
    lines.push('Errors:');
    for (const e of errors) lines.push(`  - ${e}`);
    lines.push('');
  }
  writeFileSync(REPORT_OUT, lines.join('\n') + '\n');
  process.stdout.write(
    `Wrote registry to ${relative(REPO_ROOT, REGISTRY_OUT)}\n`,
  );
  process.stdout.write(`Wrote report to ${relative(REPO_ROOT, REPORT_OUT)}\n`);
}

main();
