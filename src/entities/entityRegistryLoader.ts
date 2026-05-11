import entityRegistryRaw from './entityRegistry.json';
import type {
  AnimatedEntityAnimConfig,
  AnimatedEntityAttackConfig,
  AnimatedEntityBehaviorConfig,
  AnimatedEntityConfig,
  AnimatedEntityHitboxConfig,
  EntityRegistry,
} from './entityRegistryTypes';

// Anim-key namespace for animated entities. Keeps entity animation keys
// disjoint from player keys (which use `{mode}_{anim}` like `sword_master_idle`)
// so the Phaser anim system can't accidentally resolve one as the other.
const ENTITY_KEY_PREFIX = 'entity';

interface ParsedEntry {
  readonly identifier: string;
  readonly config: AnimatedEntityConfig;
}

// Validates one registry entry. Throws with a clear message naming the
// offending identifier and field so authoring mistakes surface at boot
// rather than at first spawn (much later in the lifecycle).
function validateEntry(
  identifier: string,
  raw: unknown,
): AnimatedEntityConfig {
  if (raw == null || typeof raw !== 'object') {
    throw new Error(
      `entityRegistry["${identifier}"] is not an object`,
    );
  }
  const entry = raw as Record<string, unknown>;
  const defaultAnimation = entry.defaultAnimation;
  if (typeof defaultAnimation !== 'string' || defaultAnimation.length === 0) {
    throw new Error(
      `entityRegistry["${identifier}"].defaultAnimation must be a non-empty string`,
    );
  }
  const physicsBodyRaw = entry.physicsBody;
  if (physicsBodyRaw == null || typeof physicsBodyRaw !== 'object') {
    throw new Error(
      `entityRegistry["${identifier}"].physicsBody must be an object with width/height`,
    );
  }
  const physicsBody = physicsBodyRaw as Record<string, unknown>;
  if (
    typeof physicsBody.width !== 'number' ||
    typeof physicsBody.height !== 'number'
  ) {
    throw new Error(
      `entityRegistry["${identifier}"].physicsBody.width/height must be numbers`,
    );
  }
  const animationsRaw = entry.animations;
  if (animationsRaw == null || typeof animationsRaw !== 'object') {
    throw new Error(
      `entityRegistry["${identifier}"].animations must be an object`,
    );
  }
  const animations: Record<string, AnimatedEntityAnimConfig> = {};
  for (const [animKey, animRaw] of Object.entries(animationsRaw)) {
    animations[animKey] = validateAnim(identifier, animKey, animRaw);
  }
  if (!(defaultAnimation in animations)) {
    throw new Error(
      `entityRegistry["${identifier}"].defaultAnimation "${defaultAnimation}" not present in animations`,
    );
  }
  const behavior =
    entry.behavior === undefined
      ? undefined
      : validateBehavior(identifier, entry.behavior, animations);
  return {
    defaultAnimation,
    physicsBody: {
      width: physicsBody.width,
      height: physicsBody.height,
    },
    gravity: entry.gravity === true,
    animations,
    behavior,
  };
}

// Validates a behavior block: requires health, accepts optional hurtAnimation,
// deathAnimation, and an optional attack sub-block (validated separately).
// Errors include the identifier and the available animation list so authoring
// mistakes surface at boot rather than at first spawn — this is the primary
// defense against the registry/animation-key drift class of bugs.
function validateBehavior(
  identifier: string,
  raw: unknown,
  animations: Readonly<Record<string, AnimatedEntityAnimConfig>>,
): AnimatedEntityBehaviorConfig {
  if (raw == null || typeof raw !== 'object') {
    throw new Error(
      `entityRegistry["${identifier}"].behavior must be an object when set`,
    );
  }
  const b = raw as Record<string, unknown>;
  const ctx = `entityRegistry["${identifier}"].behavior`;

  const healthRaw = b.health;
  if (
    typeof healthRaw !== 'number' ||
    !Number.isFinite(healthRaw) ||
    healthRaw <= 0
  ) {
    throw new Error(
      `${ctx}.health must be a positive number (got ${JSON.stringify(healthRaw)})`,
    );
  }
  const health = healthRaw;

  const hurtAnimation = optionalAnimKey(
    ctx,
    'hurtAnimation',
    b.hurtAnimation,
    animations,
  );
  const deathAnimation = optionalAnimKey(
    ctx,
    'deathAnimation',
    b.deathAnimation,
    animations,
  );
  let immovable: boolean | undefined;
  if (b.immovable !== undefined) {
    if (typeof b.immovable !== 'boolean') {
      throw new Error(`${ctx}.immovable must be a boolean when set`);
    }
    immovable = b.immovable;
  }
  const attack =
    b.attack === undefined
      ? undefined
      : validateAttack(identifier, b.attack, animations);

  let attackPool: ReadonlyArray<AnimatedEntityAttackConfig> | undefined;
  if (b.attackPool !== undefined) {
    if (!Array.isArray(b.attackPool)) {
      throw new Error(`${ctx}.attackPool must be an array when set`);
    }
    if (b.attackPool.length === 0) {
      throw new Error(
        `${ctx}.attackPool is empty — drop the field or add at least one entry. Use the single \`attack\` field for one-attack enemies.`,
      );
    }
    attackPool = b.attackPool.map((entry) =>
      validateAttack(identifier, entry, animations),
    );
  }

  return {
    health,
    hurtAnimation,
    deathAnimation,
    immovable,
    attack,
    attackPool,
  };
}

function validateAttack(
  identifier: string,
  raw: unknown,
  animations: Readonly<Record<string, AnimatedEntityAnimConfig>>,
): AnimatedEntityAttackConfig {
  if (raw == null || typeof raw !== 'object') {
    throw new Error(
      `entityRegistry["${identifier}"].behavior.attack must be an object when set`,
    );
  }
  const a = raw as Record<string, unknown>;
  const ctx = `entityRegistry["${identifier}"].behavior.attack`;

  const type = a.type;
  if (
    type !== 'melee' &&
    type !== 'ranged' &&
    type !== 'magic' &&
    type !== 'contact' &&
    type !== 'heal'
  ) {
    throw new Error(
      `${ctx}.type must be "melee" | "ranged" | "magic" | "contact" | "heal" (got ${JSON.stringify(type)})`,
    );
  }

  const requirePositive = (field: string): number => {
    const value = a[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(
        `${ctx}.${field} must be a positive number (got ${JSON.stringify(value)})`,
      );
    }
    return value;
  };
  const requireNonNegativeInt = (field: string): number => {
    const value = a[field];
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0
    ) {
      throw new Error(
        `${ctx}.${field} must be a non-negative integer (got ${JSON.stringify(value)})`,
      );
    }
    return value;
  };
  const optionalPositive = (field: string): number | undefined => {
    const value = a[field];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(
        `${ctx}.${field} must be a positive number when set (got ${JSON.stringify(value)})`,
      );
    }
    return value;
  };
  const optionalFraction = (field: string): number | undefined => {
    const value = a[field];
    if (value === undefined) return undefined;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value >= 1
    ) {
      throw new Error(
        `${ctx}.${field} must be a number in (0, 1) exclusive when set (got ${JSON.stringify(value)})`,
      );
    }
    return value;
  };

  const cooldownMs = requirePositive('cooldownMs');
  if (typeof a.aggressive !== 'boolean') {
    throw new Error(`${ctx}.aggressive must be a boolean`);
  }
  const aggressive = a.aggressive;

  const chaseRange = optionalPositive('chaseRange');
  const moveSpeed = optionalPositive('moveSpeed');
  const walkAnimation = optionalAnimKey(
    ctx,
    'walkAnimation',
    a.walkAnimation,
    animations,
  );

  // Per-type field requirements. Building the result fields conditionally
  // keeps the runtime data lean — unused fields stay undefined rather than
  // null-filled, so the consumer code can rely on type-driven branches.
  let animation: string | undefined;
  let frame: number | undefined;
  let damage: number | undefined;
  let heal: number | undefined;
  let healThreshold: number | undefined;
  let range: number | undefined;
  let hitbox: AnimatedEntityHitboxConfig | undefined;
  let projectileAnimIdle: string | undefined;
  let projectileAnimExplode: string | undefined;
  let projectileSpeed: number | undefined;

  if (type === 'contact') {
    // Contact bumps damage on body overlap. No animation, no frame, no
    // range — the cooldown alone gates re-damage. Hitbox is implicit
    // (the body itself); the player's invuln window does the work of
    // preventing tick-storms from a wasp sticking to the player.
    damage = requirePositive('damage');
  } else if (type === 'heal') {
    animation = requireAnimKeyExists(ctx, 'animation', a.animation, animations);
    frame = requireNonNegativeInt('frame');
    if (frame >= animations[animation].frameCount) {
      throw new Error(
        `${ctx}.frame ${frame} is out of range for "${animation}" (frameCount=${animations[animation].frameCount})`,
      );
    }
    if (animations[animation].loops) {
      throw new Error(
        `${ctx}.animation "${animation}" must be one-shot (loops: false) — a heal that loops forever would trap the enemy in 'attack' state`,
      );
    }
    heal = requirePositive('heal');
    healThreshold = optionalFraction('healThreshold');
  } else {
    // melee / ranged / magic — animated, frame-gated, range-checked
    animation = requireAnimKeyExists(ctx, 'animation', a.animation, animations);
    frame = requireNonNegativeInt('frame');
    if (frame >= animations[animation].frameCount) {
      throw new Error(
        `${ctx}.frame ${frame} is out of range for "${animation}" (frameCount=${animations[animation].frameCount})`,
      );
    }
    if (animations[animation].loops) {
      throw new Error(
        `${ctx}.animation "${animation}" must be one-shot (loops: false) — an attack that loops forever would trap the enemy in 'attack' state`,
      );
    }
    damage = requirePositive('damage');
    range = requirePositive('range');

    if (type === 'melee') {
      const hitboxRaw = a.hitbox;
      if (hitboxRaw == null || typeof hitboxRaw !== 'object') {
        throw new Error(
          `${ctx}.hitbox is required for melee attack (object with offsetX/offsetY/width/height)`,
        );
      }
      const hb = hitboxRaw as Record<string, unknown>;
      const requireHitboxNum = (field: string): number => {
        const value = hb[field];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(
            `${ctx}.hitbox.${field} must be a number (got ${JSON.stringify(value)})`,
          );
        }
        return value;
      };
      const hbWidth = requireHitboxNum('width');
      const hbHeight = requireHitboxNum('height');
      if (hbWidth <= 0 || hbHeight <= 0) {
        throw new Error(
          `${ctx}.hitbox.width and height must be > 0 (got ${hbWidth}x${hbHeight})`,
        );
      }
      hitbox = {
        offsetX: requireHitboxNum('offsetX'),
        offsetY: requireHitboxNum('offsetY'),
        width: hbWidth,
        height: hbHeight,
      };
    } else {
      projectileAnimIdle = requireAnimKeyExists(
        ctx,
        'projectileAnimIdle',
        a.projectileAnimIdle,
        animations,
      );
      projectileAnimExplode = requireAnimKeyExists(
        ctx,
        'projectileAnimExplode',
        a.projectileAnimExplode,
        animations,
      );
      projectileSpeed = requirePositive('projectileSpeed');
    }
  }

  return {
    type,
    animation,
    frame,
    damage,
    heal,
    healThreshold,
    range,
    cooldownMs,
    aggressive,
    chaseRange,
    moveSpeed,
    walkAnimation,
    hitbox,
    projectileAnimIdle,
    projectileAnimExplode,
    projectileSpeed,
  };
}

// Shared helpers for animation-key validation. Hoisted out of validateBehavior/
// validateAttack so both can throw consistent errors that name the offending
// field with its full ctx path and list the available keys.
function requireAnimKeyExists(
  ctx: string,
  field: string,
  animKey: unknown,
  animations: Readonly<Record<string, AnimatedEntityAnimConfig>>,
): string {
  if (typeof animKey !== 'string' || animKey.length === 0) {
    throw new Error(
      `${ctx}.${field} must be a non-empty animation key string`,
    );
  }
  if (!(animKey in animations)) {
    throw new Error(
      `${ctx}.${field} references "${animKey}", which is not in animations. Available: [${Object.keys(animations).join(', ')}]`,
    );
  }
  return animKey;
}

function optionalAnimKey(
  ctx: string,
  field: string,
  animKey: unknown,
  animations: Readonly<Record<string, AnimatedEntityAnimConfig>>,
): string | undefined {
  if (animKey === undefined) return undefined;
  return requireAnimKeyExists(ctx, field, animKey, animations);
}

function validateAnim(
  identifier: string,
  animKey: string,
  raw: unknown,
): AnimatedEntityAnimConfig {
  if (raw == null || typeof raw !== 'object') {
    throw new Error(
      `entityRegistry["${identifier}"].animations["${animKey}"] is not an object`,
    );
  }
  const anim = raw as Record<string, unknown>;
  const requireNum = (field: string): number => {
    const value = anim[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(
        `entityRegistry["${identifier}"].animations["${animKey}"].${field} must be a positive number`,
      );
    }
    return value;
  };
  const file = anim.file;
  if (typeof file !== 'string' || file.length === 0) {
    throw new Error(
      `entityRegistry["${identifier}"].animations["${animKey}"].file must be a non-empty string`,
    );
  }
  const optionalNum = (field: string): number | undefined => {
    const value = anim[field];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `entityRegistry["${identifier}"].animations["${animKey}"].${field} must be a number when set`,
      );
    }
    return value;
  };
  return {
    file,
    frameWidth: requireNum('frameWidth'),
    frameHeight: requireNum('frameHeight'),
    frameCount: requireNum('frameCount'),
    loops: anim.loops !== false,
    anchorX: optionalNum('anchorX'),
    anchorY: optionalNum('anchorY'),
    displayScale: optionalNum('displayScale'),
  };
}

const PARSED_ENTRIES: ReadonlyArray<ParsedEntry> = (() => {
  const raw = entityRegistryRaw as Record<string, unknown>;
  const out: ParsedEntry[] = [];
  for (const [identifier, value] of Object.entries(raw)) {
    out.push({ identifier, config: validateEntry(identifier, value) });
  }
  return out;
})();

const REGISTRY: EntityRegistry = Object.freeze(
  Object.fromEntries(PARSED_ENTRIES.map((e) => [e.identifier, e.config])),
);

export function getEntityRegistryEntry(
  identifier: string,
): AnimatedEntityConfig | null {
  return REGISTRY[identifier] ?? null;
}

export function getEntityBehavior(
  identifier: string,
): AnimatedEntityBehaviorConfig | null {
  return REGISTRY[identifier]?.behavior ?? null;
}

export function listEntityRegistryEntries(): ReadonlyArray<ParsedEntry> {
  return PARSED_ENTRIES;
}

// Phaser texture and animation key for a given (identifier, animKey).
// Namespaced under `entity_` so it cannot collide with player keys.
export function entityAnimFullKey(
  identifier: string,
  animKey: string,
): string {
  return `${ENTITY_KEY_PREFIX}_${identifier}_${animKey}`;
}

// Lookup the registry anim config behind a full key. Used by getSpriteAnchor
// to resolve entity anims uniformly alongside player anims.
const ANIM_BY_FULL_KEY: ReadonlyMap<string, AnimatedEntityAnimConfig> = (() => {
  const map = new Map<string, AnimatedEntityAnimConfig>();
  for (const { identifier, config } of PARSED_ENTRIES) {
    for (const [animKey, anim] of Object.entries(config.animations)) {
      map.set(entityAnimFullKey(identifier, animKey), anim);
    }
  }
  return map;
})();

export function getEntityAnimByFullKey(
  fullKey: string,
): AnimatedEntityAnimConfig | undefined {
  return ANIM_BY_FULL_KEY.get(fullKey);
}

export function isEntityAnimFullKey(fullKey: string): boolean {
  return fullKey.startsWith(`${ENTITY_KEY_PREFIX}_`);
}
