import Phaser from 'phaser';
import type { LdtkEntityInstance } from '../ldtk/types';
import { AnimatedEntity } from './AnimatedEntity';
import { Enemy } from './Enemy';
import { listEntityRegistryEntries } from './entityRegistryLoader';
import { Player } from './Player';

export type EntityFactoryFn = (
  scene: Phaser.Scene,
  instance: LdtkEntityInstance,
) => Phaser.GameObjects.GameObject;

// LDtk identifiers handled by gameplay code rather than the JSON-authored
// entity registry. Currently just the player; future gameplay-bearing
// entities (interactive NPCs, doors with logic, etc.) get hand-written
// factories here.
const SPECIAL_FACTORIES: Readonly<Record<string, EntityFactoryFn>> = {
  Sword_master_spawn: (scene, instance) => {
    const { x, y } = pivotCenter(instance);
    return new Player(scene, x, y);
  },
};

// Single source of truth for "LDtk entity identifier → in-game spawn".
// Composed of SPECIAL_FACTORIES (hand-authored) plus an auto-generated
// AnimatedEntity factory for every identifier in the entity registry.
// Adding a new animated entity is one JSON entry; adding a new gameplay
// entity is one entry in SPECIAL_FACTORIES.
const FACTORIES: Readonly<Record<string, EntityFactoryFn>> = (() => {
  const out: Record<string, EntityFactoryFn> = { ...SPECIAL_FACTORIES };
  for (const { identifier, config } of listEntityRegistryEntries()) {
    if (identifier in out) {
      // Defense against silent overwrites: if an identifier is registered
      // both as a special factory and in the entity registry, the special
      // factory wins but we want to know about the duplication.
      throw new Error(
        `Entity identifier "${identifier}" appears in both SPECIAL_FACTORIES and entityRegistry.json — remove the duplication`,
      );
    }
    // Presence of a behavior block is the single switch between Enemy (has
    // health/AI/attacks) and AnimatedEntity (pure-decoration). Capture the
    // boolean at factory-build time so spawn-time work is just a constructor
    // call.
    if (config.behavior) {
      out[identifier] = (scene, instance) => {
        const { x, y } = pivotCenter(instance);
        return new Enemy(scene, x, y, identifier);
      };
    } else {
      out[identifier] = (scene, instance) => {
        const { x, y } = pivotCenter(instance);
        return new AnimatedEntity(scene, x, y, identifier);
      };
    }
  }
  return out;
})();

// Identifiers of entities spawned dynamically by this factory. Exposed so the
// LDtk renderer can suppress the static decoration tile that LDtk includes for
// these (every entity def carries a __tile preview rect for the editor) —
// otherwise the entity would render twice: once as the live sprite and once
// as a frozen image at the spawn location. Auto-derived from FACTORIES so
// registry additions update the suppression set without a manual sync point.
export const DYNAMIC_ENTITY_IDENTIFIERS: ReadonlySet<string> = new Set(
  Object.keys(FACTORIES),
);

export interface SpawnedEntities {
  player: Player | null;
  enemies: ReadonlyArray<Enemy>;
  // Pure-decoration AnimatedEntities (chests, ambient animals, traps).
  // Kept distinct from `enemies` so GameScene can iterate enemies per-frame
  // without an instanceof check.
  others: ReadonlyArray<Phaser.GameObjects.GameObject>;
}

export function spawnEntities(
  scene: Phaser.Scene,
  instances: ReadonlyArray<LdtkEntityInstance>,
): SpawnedEntities {
  let player: Player | null = null;
  const enemies: Enemy[] = [];
  const others: Phaser.GameObjects.GameObject[] = [];
  const unhandled = new Set<string>();

  for (const instance of instances) {
    const factory = FACTORIES[instance.__identifier];
    if (!factory) {
      // Decoration entities (LDtk entity-with-embedded-__tile pattern) are
      // rendered by LevelRenderer and intentionally have no factory here.
      // Skip silently so they don't pollute the "unhandled" warning, which
      // is reserved for genuinely-missing game-entity factories.
      if (instance.__tile) continue;
      unhandled.add(instance.__identifier);
      continue;
    }
    const obj = factory(scene, instance);
    if (obj instanceof Player) {
      if (player) {
        throw new Error(
          `Multiple Player spawns from entity "${instance.__identifier}" — expected exactly one`,
        );
      }
      player = obj;
    } else if (obj instanceof Enemy) {
      enemies.push(obj);
    } else {
      others.push(obj);
    }
  }

  if (unhandled.size > 0) {
    // Once-per-load summary keeps logs tidy as more LDtk entities exist than
    // are wired up in code. Per-entity factories should be added incrementally.
    console.warn(
      `[EntityFactory] No factory registered for: ${[...unhandled].sort().join(', ')}`,
    );
  }

  return { player, enemies, others };
}

// Symmetric teardown for spawnEntities. Optionally preserves the player so
// callers (e.g. HMR reloads) can keep the existing Player instance and just
// re-attach colliders to a freshly-built world. Player has its own DESTROY
// listener that detaches input handlers, so destroying it here is safe.
export function destroyEntities(
  spawned: SpawnedEntities,
  options: { preservePlayer?: boolean } = {},
): void {
  for (const enemy of spawned.enemies) {
    enemy.destroy();
  }
  for (const obj of spawned.others) {
    obj.destroy();
  }
  if (!options.preservePlayer && spawned.player) {
    spawned.player.destroy();
  }
}

// Translate an LDtk entity instance position (anchored at its def's pivot)
// into the center of its bounding box, in world coordinates. LDtk's `px` is
// computed as (boxTopLeft + pivot * size); reverse it so spawned sprites land
// at the box center regardless of pivot configuration. Prefer `__worldX/Y`
// (set by LDtk for Free world layouts) so entities from any level land in the
// same coordinate space the renderer uses.
function pivotCenter(e: LdtkEntityInstance): { x: number; y: number } {
  const baseX = e.__worldX ?? e.px[0];
  const baseY = e.__worldY ?? e.px[1];
  return {
    x: baseX + (0.5 - e.__pivot[0]) * e.width,
    y: baseY + (0.5 - e.__pivot[1]) * e.height,
  };
}
