import Phaser from 'phaser';
import {
  entityAnimFullKey,
  getEntityAnimByFullKey,
  listEntityRegistryEntries,
} from '../entities/entityRegistryLoader';
import swordMasterRaw from './swordMaster.json';
import swordMasterMagicRaw from './swordMasterMagic.json';
import gunslingerGun1Raw from './gunslingerGun1.json';
import gunslingerGun2Raw from './gunslingerGun2.json';
import gunslingerBodyRaw from './gunslingerBody.json';
import gun1OverlayRaw from './gun1Overlay.json';
import gun2OverlayRaw from './gun2Overlay.json';
import type {
  AnimationStage,
  AnyModeId,
  CharacterModeId,
  CharacterModeRegistry,
  LogicalAnimationKey,
  OverlayModeId,
  ResolvedAnimation,
  SimpleAnimation,
} from './characterTypes';

const REGULAR_REGISTRY = swordMasterRaw as CharacterModeRegistry;
const MAGIC_REGISTRY = swordMasterMagicRaw as CharacterModeRegistry;
const GUN1_REGISTRY = gunslingerGun1Raw as CharacterModeRegistry;
const GUN2_REGISTRY = gunslingerGun2Raw as CharacterModeRegistry;
const GUNSLINGER_BODY_REGISTRY = gunslingerBodyRaw as CharacterModeRegistry;
const GUN1_OVERLAY_REGISTRY = gun1OverlayRaw as CharacterModeRegistry;
const GUN2_OVERLAY_REGISTRY = gun2OverlayRaw as CharacterModeRegistry;

const REGISTRIES: ReadonlyArray<CharacterModeRegistry> = [
  REGULAR_REGISTRY,
  MAGIC_REGISTRY,
  GUN1_REGISTRY,
  GUN2_REGISTRY,
  GUNSLINGER_BODY_REGISTRY,
  GUN1_OVERLAY_REGISTRY,
  GUN2_OVERLAY_REGISTRY,
];

export const SWORD_MASTER_MODE: CharacterModeId = 'sword_master';
export const SWORD_MASTER_MAGIC_PREFIX = 'sword_master_magic';
export const DEFAULT_CHARACTER_FPS = 12;

// Wheel-cycled mode order. sword_master_magic is intentionally absent — it's
// a sub-stance of sword_master toggled by F.
export const MODE_ORDER: ReadonlyArray<CharacterModeId> = [
  'sword_master',
  'gunslinger_gun1',
  'gunslinger_gun2',
];

// Per-mode mapping of logical action keys to underlying registry animations.
// `null` = action disabled in this mode (gating in Player.ts must early-return).
// `pauseOnFrame` = freeze on a specific frame after play (turns a multi-frame
// anim into a static pose, e.g., gunslinger uses run frame 0 if idle missing).
type ModeResolverTable = Partial<
  Record<LogicalAnimationKey, ResolvedAnimation | null>
>;

const MODE_RESOLVERS: Record<CharacterModeId, ModeResolverTable> = {
  sword_master: {
    idle: { registryKey: 'idle' },
    run: { registryKey: 'run' },
    fall: { registryKey: 'fall1' },
    wall_slide: { registryKey: 'ledge_slide' },
    attack1: { registryKey: 'attack1' },
    attack2: { registryKey: 'attack2' },
    attack3: { registryKey: 'attack3' },
    attack4: { registryKey: 'attack4' },
    attack5: { registryKey: 'attack5' },
    attack6: { registryKey: 'attack6' },
    dash: { registryKey: 'dash' },
    roll: { registryKey: 'roll' },
    block: { registryKey: 'block' },
    ledge_climb: { registryKey: 'ledge_climb' },
    jump: null,
    death: { registryKey: 'death' },
    take_hit: { registryKey: 'take_hit' },
  },
  // Mixed sourcing per the user's design:
  //   - idle/run/fall/wall_slide/jump → gunslinger_body (no_gun art);
  //     PlayerGun overlays a separate gun sprite on top of these frames.
  //   - death/roll/take_hit/ledge_climb → own gun-mode registry (the gun is
  //     baked into those spritesheets); PlayerGun is hidden during these.
  // attack1 is intentionally null: firing animates the gun overlay only;
  // the body keeps tracking physics state (idle/run/fall) during the shot.
  gunslinger_gun1: {
    idle: { registryKey: 'idle', sourceMode: 'gunslinger_body' },
    run: { registryKey: 'run', sourceMode: 'gunslinger_body' },
    fall: { registryKey: 'fall', sourceMode: 'gunslinger_body' },
    wall_slide: { registryKey: 'ledge_slide', sourceMode: 'gunslinger_body' },
    attack1: null,
    attack2: null,
    attack3: null,
    attack4: null,
    attack5: null,
    attack6: null,
    dash: null,
    roll: { registryKey: 'roll' },
    block: null,
    ledge_climb: { registryKey: 'ledge_grab' },
    jump: { registryKey: 'jump', sourceMode: 'gunslinger_body' },
    death: { registryKey: 'death' },
    take_hit: { registryKey: 'take_hit' },
  },
  gunslinger_gun2: {
    idle: { registryKey: 'idle', sourceMode: 'gunslinger_body' },
    run: { registryKey: 'run', sourceMode: 'gunslinger_body' },
    fall: { registryKey: 'fall', sourceMode: 'gunslinger_body' },
    wall_slide: { registryKey: 'ledge_slide', sourceMode: 'gunslinger_body' },
    attack1: null,
    attack2: null,
    attack3: null,
    attack4: null,
    attack5: null,
    attack6: null,
    dash: null,
    roll: { registryKey: 'roll' },
    block: null,
    ledge_climb: { registryKey: 'ledge_grab' },
    jump: { registryKey: 'jump', sourceMode: 'gunslinger_body' },
    death: { registryKey: 'death' },
    take_hit: { registryKey: 'take_hit' },
  },
};

// Magic attack chain (sub-stance of sword_master). Index = combo step.
// step 1 = roll-attack (magic 'attack1'); steps 2-5 follow the user's spec.
const MAGIC_ATTACK_KEY_BY_STEP: ReadonlyArray<string | null> = [
  null,
  'attack1',
  'attack3',
  'attack4',
  'attack2',
  'attack5',
];

function registryPrefix(registry: CharacterModeRegistry): string {
  return registry.mode ?? 'sword_master';
}

function fullKeyFor(registry: CharacterModeRegistry, localKey: string): string {
  return `${registryPrefix(registry)}_${localKey}`;
}

const animationByFullKey: ReadonlyMap<string, SimpleAnimation> = (() => {
  const map = new Map<string, SimpleAnimation>();
  for (const registry of REGISTRIES) {
    for (const anim of Object.values(registry.animations)) {
      map.set(fullKeyFor(registry, anim.key), anim);
    }
  }
  return map;
})();

// fullKey → owning registry's mode. Used by Player to decide gun-overlay
// visibility: if the body's currently-playing anim came from `gunslinger_body`,
// the overlay shows; if it came from a baked-gun registry, the overlay hides.
const animationSourceMode: ReadonlyMap<string, AnyModeId> = (() => {
  const map = new Map<string, AnyModeId>();
  for (const registry of REGISTRIES) {
    const mode = registryPrefix(registry) as AnyModeId;
    for (const anim of Object.values(registry.animations)) {
      map.set(fullKeyFor(registry, anim.key), mode);
    }
  }
  return map;
})();

export function getAnimationSourceMode(fullAnimKey: string): AnyModeId | null {
  return animationSourceMode.get(fullAnimKey) ?? null;
}

export function animKey(
  mode: CharacterModeId,
  logical: LogicalAnimationKey,
): string | null {
  const resolved = MODE_RESOLVERS[mode][logical];
  if (!resolved) return null;
  const sourceMode = resolved.sourceMode ?? mode;
  return `${sourceMode}_${resolved.registryKey}`;
}

export function isActionAvailable(
  mode: CharacterModeId,
  logical: LogicalAnimationKey,
): boolean {
  return MODE_RESOLVERS[mode][logical] != null;
}

export function magicAttackAnimKey(step: number): string {
  const localKey = MAGIC_ATTACK_KEY_BY_STEP[step];
  if (!localKey) {
    throw new Error(`No magic attack defined for step ${step}`);
  }
  return `${SWORD_MASTER_MAGIC_PREFIX}_${localKey}`;
}

// Convenience: build a Set of full anim keys for any animations matching
// a logical key across all modes. Used in Player.ts to identify attack/dash/
// roll/block/climb keys arriving at onAnimationComplete without per-mode
// branching.
export function fullKeysForLogical(
  logical: LogicalAnimationKey,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const mode of Object.keys(MODE_RESOLVERS) as CharacterModeId[]) {
    const key = animKey(mode, logical);
    if (key) keys.add(key);
  }
  return keys;
}

export function magicAttackKeySet(): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const localKey of MAGIC_ATTACK_KEY_BY_STEP) {
    if (localKey) {
      keys.add(`${SWORD_MASTER_MAGIC_PREFIX}_${localKey}`);
    }
  }
  return keys;
}

export function preloadAllCharacters(scene: Phaser.Scene): void {
  for (const [fullKey, anim] of animationByFullKey) {
    scene.load.spritesheet(fullKey, `/${anim.file}`, {
      frameWidth: anim.frames.frameWidth,
      frameHeight: anim.frames.frameHeight,
    });
  }
}

export interface RegisterAnimationsOptions {
  defaultFps?: number;
}

export interface SpriteAnchor {
  originX: number;
  originY: number;
  // Source-pixel size to pass to body.setSize. Phaser scales body.width to
  // sourceWidth * sprite.scaleX each frame, so dividing by displayScale here
  // keeps the world-space hitbox at PHYSICS_BODY size regardless of scale.
  bodySourceWidth: number;
  bodySourceHeight: number;
  // Source-pixel offset to pass to body.setOffset. Phaser computes
  //   body.position = sprite.position - displayOrigin*scale + offset*scale
  // so offsets are likewise interpreted pre-scale.
  bodyOffsetX: number;
  bodyOffsetY: number;
  // Visual scale to apply via sprite.setScale.
  displayScale: number;
}

const DEFAULT_ANCHOR: SpriteAnchor = {
  originX: 0.5,
  originY: 0.5,
  bodySourceWidth: 0,
  bodySourceHeight: 0,
  bodyOffsetX: 0,
  bodyOffsetY: 0,
  displayScale: 1,
};

export function getAnimationStage(
  fullAnimKey: string,
  stageName: string,
): AnimationStage | undefined {
  return animationByFullKey.get(fullAnimKey)?.stages?.[stageName];
}

// Prefix used on the synthetic `mode` field for animated-entity listings.
// The resizer routes saves by looking at this prefix on listing.mode; see
// tools/anim-resizer/persist.ts. Must match entityRegistryLoader's
// ENTITY_KEY_PREFIX so fullKey resolution stays consistent.
export const ENTITY_LISTING_MODE_PREFIX = 'entity_';

export interface AnimationListing {
  fullKey: string;
  // Widened from AnyModeId so synthetic per-entity modes (e.g.
  // `entity_Caged_spider_spawn`) fit alongside the fixed player modes.
  // Consumers only treat this as an opaque string for routing.
  mode: string;
  registry: CharacterModeRegistry;
  anim: SimpleAnimation;
  // True when this listing was synthesized from the JSON entity registry
  // (one per LDtk identifier). Player listings have this undefined/false.
  isEntity?: boolean;
  // The LDtk identifier this entity was synthesized from; absent on
  // player listings.
  entityIdentifier?: string;
}

// Tool-side iteration over every registry's animations. Mirrors the data
// preloadAllCharacters/registerAllCharacterAnimations walk, exposed as a
// flat list for the resizer UI. Includes both the player registries (one
// per CharacterModeRegistry) and the entity registry (one synthetic
// CharacterModeRegistry per LDtk identifier).
export function listAnimations(): ReadonlyArray<AnimationListing> {
  const out: AnimationListing[] = [];
  for (const registry of REGISTRIES) {
    const mode = registryPrefix(registry) as AnyModeId;
    for (const anim of Object.values(registry.animations)) {
      out.push({
        fullKey: fullKeyFor(registry, anim.key),
        mode,
        registry,
        anim,
      });
    }
  }
  for (const { identifier, config } of listEntityRegistryEntries()) {
    const syntheticMode = `${ENTITY_LISTING_MODE_PREFIX}${identifier}`;
    // Build a CharacterModeRegistry-shaped object per entity. The animations
    // are flattened from AnimatedEntityAnimConfig (where frame fields are
    // direct) into SimpleAnimation (where they nest under .frames) so every
    // downstream resizer file (state, EditPanel, PreviewScene) keeps working
    // against one shape.
    const animations: Record<string, SimpleAnimation> = {};
    for (const [animKey, entityAnim] of Object.entries(config.animations)) {
      animations[animKey] = {
        type: 'simple',
        key: animKey,
        file: entityAnim.file,
        category: 'state',
        loops: entityAnim.loops !== false,
        frames: {
          sheetWidth: entityAnim.frameWidth * entityAnim.frameCount,
          sheetHeight: entityAnim.frameHeight,
          frameWidth: entityAnim.frameWidth,
          frameHeight: entityAnim.frameHeight,
          frameCount: entityAnim.frameCount,
          ...(entityAnim.anchorX !== undefined
            ? { anchorX: entityAnim.anchorX }
            : {}),
          ...(entityAnim.anchorY !== undefined
            ? { anchorY: entityAnim.anchorY }
            : {}),
          ...(entityAnim.displayScale !== undefined
            ? { displayScale: entityAnim.displayScale }
            : {}),
        },
        originalName: animKey,
      };
    }
    const syntheticRegistry: CharacterModeRegistry = {
      type: 'standard',
      id: syntheticMode,
      path: `entityRegistry/${identifier}`,
      mode: syntheticMode,
      animations,
    };
    for (const anim of Object.values(animations)) {
      out.push({
        fullKey: entityAnimFullKey(identifier, anim.key),
        mode: syntheticMode,
        registry: syntheticRegistry,
        anim,
        isEntity: true,
        entityIdentifier: identifier,
      });
    }
  }
  return out;
}

// Returns the natural playback duration (ms) of an animation at the default
// character FPS. Callers wanting to scale playback speed can divide this by
// a multiplier and pass the result as Phaser's `duration` play option.
export function getAnimationNaturalDurationMs(
  fullAnimKey: string,
): number | null {
  const anim = animationByFullKey.get(fullAnimKey);
  if (!anim) return null;
  return (anim.frames.frameCount * 1000) / DEFAULT_CHARACTER_FPS;
}

// Normalized frame metadata shared by player registries (SimpleAnimation)
// and the entity registry (AnimatedEntityAnimConfig). Both shapes carry the
// same anchor fields under different nesting; this view lets getSpriteAnchor
// resolve either uniformly so AnimatedEntity reuses the player's anchor math.
interface FrameMetadata {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly anchorX?: number;
  readonly anchorY?: number;
  readonly displayScale?: number;
}

function lookupFrameMetadata(fullAnimKey: string): FrameMetadata | null {
  const playerAnim = animationByFullKey.get(fullAnimKey);
  if (playerAnim) return playerAnim.frames;
  const entityAnim = getEntityAnimByFullKey(fullAnimKey);
  if (entityAnim) {
    return {
      frameWidth: entityAnim.frameWidth,
      frameHeight: entityAnim.frameHeight,
      anchorX: entityAnim.anchorX,
      anchorY: entityAnim.anchorY,
      displayScale: entityAnim.displayScale,
    };
  }
  return null;
}

export function getSpriteAnchor(
  fullAnimKey: string,
  bodyWidth: number,
  bodyHeight: number,
  flipX: boolean = false,
): SpriteAnchor {
  const frame = lookupFrameMetadata(fullAnimKey);
  if (!frame) {
    return DEFAULT_ANCHOR;
  }
  const { frameWidth, frameHeight, anchorX, anchorY, displayScale } = frame;
  const scale = displayScale ?? 1;
  const ax = anchorX ?? frameWidth / 2;
  const ay = anchorY ?? frameHeight;
  const effectiveAx = flipX ? frameWidth - ax : ax;
  // Body math at scale s:
  //   body.width  = sourceWidth  * s  → sourceWidth  = PHYSICS_BODY / s
  //   body.height = sourceHeight * s  → sourceHeight = PHYSICS_BODY / s
  // So that body.width/height in world space stay equal to PHYSICS_BODY.
  // Body offset (pre-scale) places body.center.x at the anchor column and
  // body.bottom at the anchor row in world space:
  //   offset.x = effectiveAx - bodyWidth  / (2 * s)
  //   offset.y = ay          - bodyHeight /      s
  // These reduce to the original (effectiveAx - bodyWidth/2, ay - bodyHeight)
  // when s = 1, so existing JSON renders identically.
  return {
    originX: effectiveAx / frameWidth,
    originY: 0.5,
    bodySourceWidth: bodyWidth / scale,
    bodySourceHeight: bodyHeight / scale,
    bodyOffsetX: effectiveAx - bodyWidth / (2 * scale),
    bodyOffsetY: ay - bodyHeight / scale,
    displayScale: scale,
  };
}

export function registerAllCharacterAnimations(
  scene: Phaser.Scene,
  options: RegisterAnimationsOptions = {},
): void {
  const fps = options.defaultFps ?? DEFAULT_CHARACTER_FPS;
  for (const [fullKey, anim] of animationByFullKey) {
    if (scene.anims.exists(fullKey)) continue;
    scene.anims.create({
      key: fullKey,
      frames: scene.anims.generateFrameNumbers(fullKey, {
        start: 0,
        end: anim.frames.frameCount - 1,
      }),
      frameRate: fps,
      repeat: anim.loops ? -1 : 0,
    });
  }
}

export type GunslingerProjectileMode = 'gunslinger_gun1' | 'gunslinger_gun2';
export type ProjectileAnimKind = 'idle' | 'explode';

export function projectileAnimKey(
  mode: GunslingerProjectileMode,
  kind: ProjectileAnimKind,
): string {
  return `${mode}_projectile_${kind}`;
}

// Maps a wheel-selectable gun mode to the matching gun-overlay registry mode.
// Kept as a function (not a constant union) so a future overlay swap (e.g.
// reskinning gun1) only needs to update this map.
const GUN_OVERLAY_MODE_BY_GUN: Readonly<
  Record<GunslingerProjectileMode, OverlayModeId>
> = {
  gunslinger_gun1: 'gun1_overlay',
  gunslinger_gun2: 'gun2_overlay',
};

export function gunOverlayModeFor(
  mode: GunslingerProjectileMode,
): OverlayModeId {
  return GUN_OVERLAY_MODE_BY_GUN[mode];
}

export type GunOverlayAnimKind = 'idle' | 'attack1';

export function gunOverlayAnimKey(
  mode: GunslingerProjectileMode,
  kind: GunOverlayAnimKind,
): string {
  return `${gunOverlayModeFor(mode)}_${kind}`;
}

// Mirrors preloadAllCharacters for the JSON-authored animated-entity
// registry. Each (identifier, animKey) becomes one Phaser spritesheet
// under the namespaced entityAnimFullKey so entity textures never collide
// with player textures. Called from PreloadScene.preload().
export function preloadAllEntities(scene: Phaser.Scene): void {
  for (const { identifier, config } of listEntityRegistryEntries()) {
    for (const [animKey, anim] of Object.entries(config.animations)) {
      const fullKey = entityAnimFullKey(identifier, animKey);
      scene.load.spritesheet(fullKey, anim.file, {
        frameWidth: anim.frameWidth,
        frameHeight: anim.frameHeight,
      });
    }
  }
}

// Mirrors registerAllCharacterAnimations for the entity registry. Creates
// Phaser Animation objects keyed by entityAnimFullKey so AnimatedEntity.play
// can reference them directly.
export function registerAllEntityAnimations(
  scene: Phaser.Scene,
  options: RegisterAnimationsOptions = {},
): void {
  const fps = options.defaultFps ?? DEFAULT_CHARACTER_FPS;
  for (const { identifier, config } of listEntityRegistryEntries()) {
    for (const [animKey, anim] of Object.entries(config.animations)) {
      const fullKey = entityAnimFullKey(identifier, animKey);
      if (scene.anims.exists(fullKey)) continue;
      scene.anims.create({
        key: fullKey,
        frames: scene.anims.generateFrameNumbers(fullKey, {
          start: 0,
          end: anim.frameCount - 1,
        }),
        frameRate: fps,
        // anim.loops defaults to true in entityRegistryLoader; -1 = infinite
        // repeat. One-shot animations like 'death' set loops:false in JSON.
        repeat: anim.loops ? -1 : 0,
      });
    }
  }
}
