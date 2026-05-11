// Schema for the JSON-authored animated-entity registry. Each LDtk entity
// identifier (e.g. "Caged_spider_spawn") maps to one AnimatedEntityConfig
// describing where its sprites live and how to slice the spritesheets into
// frames. The registry is the single source of truth that turns "this LDtk
// identifier should animate" into a runnable Phaser sprite — adding a new
// animated entity type is one JSON entry, not one factory function.

export interface AnimatedEntityAnimConfig {
  // Path of the spritesheet PNG, relative to /public. e.g.
  // "DarkSpriteLib/characters/caged_spider/idle.png".
  readonly file: string;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frameCount: number;
  // Default true — a missing field is interpreted as a looping animation.
  // Set false for one-shot animations like death.
  readonly loops?: boolean;
  // Frame-pixel column where the body's horizontal anchor sits. Defaults to
  // frameWidth / 2 (sprite-center). Used by getSpriteAnchor to position the
  // physics body relative to the visible frame, mirroring SimpleAnimation.
  readonly anchorX?: number;
  // Frame-pixel row (1-based from top of frame) where the body's bottom
  // edge sits. Defaults to frameHeight (body bottom = frame bottom).
  readonly anchorY?: number;
  // Visual-only scale applied to the rendered sprite. Default 1. Same
  // semantics as FrameData.displayScale on the player registries.
  readonly displayScale?: number;
}

export interface AnimatedEntityPhysicsBodyConfig {
  readonly width: number;
  readonly height: number;
}

// Melee strategies stamp a transient hitbox at this offset on the configured
// attackFrame. Offset is in source pixels; the strategy mirrors X based on
// the entity's facing direction at fire time.
export interface AnimatedEntityHitboxConfig {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
}

// Per-character attack tuning. Animation keys reference keys in this entity's
// own `animations` map — never raw Phaser keys — so the registry validator
// can prove they exist at boot. The whole block is optional under behavior:
// entities can be killable without attacking (passive enemies / ambient
// creatures that just take damage), in which case Phase 3's AI loop keeps
// them in 'idle' indefinitely.
//
// Type semantics:
//   - 'melee': transient hitbox on the attack frame
//   - 'ranged'/'magic': projectile spawned on the attack frame
//   - 'contact': damage applied on body-overlap with the player, no anim
//     needed — used for swarm enemies like wasps that "sting on touch"
//   - 'heal': self-cast on a chosen frame, restores HP up to max. Selected
//     by the AI pool only when current HP is below healThreshold (default
//     0.5), so bosses use it when wounded instead of as their opener.
export interface AnimatedEntityAttackConfig {
  readonly type: 'melee' | 'ranged' | 'magic' | 'contact' | 'heal';
  // Animation key. Required for melee/ranged/magic/heal; optional for contact
  // (which has no swing animation — the enemy walks into the player while
  // playing its default walk/idle).
  readonly animation?: string;
  // Frame index (0-based, must be < animations[animation].frameCount) at
  // which damage / projectile spawn / self-heal applies. Required for
  // animated attacks; ignored for contact.
  readonly frame?: number;
  // Damage to the player. Required for non-heal types.
  readonly damage?: number;
  // HP restored on a heal-type attack's frame. Required when type === 'heal'.
  readonly heal?: number;
  // Fraction (0..1) of max HP below which the heal becomes eligible. Default
  // 0.5 — boss heals when bloodied, not as an opener. Heal-only field.
  readonly healThreshold?: number;
  // World-pixel distance within which the entity initiates the attack.
  // Required for melee/ranged/magic (the entity must close to attack);
  // unused by contact (handled via body overlap) and heal (self-cast).
  readonly range?: number;
  readonly cooldownMs: number;
  readonly aggressive: boolean;
  // Optional chase fields. If chaseRange is set, the entity moves toward
  // the player when within that range. Absent = stationary attacker.
  readonly chaseRange?: number;
  readonly moveSpeed?: number;
  readonly walkAnimation?: string;
  // Melee-only: transient hitbox geometry.
  readonly hitbox?: AnimatedEntityHitboxConfig;
  // Ranged/magic-only: projectile animation keys + speed.
  readonly projectileAnimIdle?: string;
  readonly projectileAnimExplode?: string;
  readonly projectileSpeed?: number;
}

// Per-character combat parameters. Presence of a behavior block is the one
// signal the EntityFactory uses to spawn Enemy vs AnimatedEntity. An
// attack-less behavior (just health) is valid and produces a killable but
// passive enemy.
export interface AnimatedEntityBehaviorConfig {
  readonly health: number;
  // Animation played on take damage. Optional — some entities lack a
  // take_hit sheet, in which case the entity flickers via i-frame logic
  // without an animation swap.
  readonly hurtAnimation?: string;
  // Animation played on death. Defaults to 'death' (when an animation with
  // that key exists). Validator confirms the key resolves to a real anim.
  readonly deathAnimation?: string;
  // If true, the entity ignores knockback velocity on hurt and is marked
  // body.immovable in physics so the player can't push it either. Use for
  // anchored enemies like The_hive that must stay at their LDtk position.
  readonly immovable?: boolean;
  // Single-attack shorthand. For enemies with one combat behavior. Mutually
  // exclusive with attackPool in practice — if both are set, attackPool wins
  // and attack is ignored (validator warns at boot).
  readonly attack?: AnimatedEntityAttackConfig;
  // Multi-attack pool. Boss-style enemies pick a random eligible entry per
  // attack cycle (eligible = type matches the current situation: melee/
  // ranged in range, heal when HP below threshold, contact always evaluated
  // independently on body overlap). Empty array is invalid; use the single
  // `attack` field instead.
  readonly attackPool?: ReadonlyArray<AnimatedEntityAttackConfig>;
}

export interface AnimatedEntityConfig {
  // Name of the animation key (within `animations`) that the entity plays
  // on spawn. Required so partial-anim entities (e.g. The_hive has only
  // idle + death, no walk) declare a sensible default and the system never
  // has to guess.
  readonly defaultAnimation: string;
  // Per-entity physics body. Width/height in source pixels (pre-scale);
  // AnimatedEntity divides by displayScale internally so the world-space
  // hitbox stays at this size regardless of the sprite's display scale.
  readonly physicsBody: AnimatedEntityPhysicsBodyConfig;
  // Whether Arcade gravity affects this entity. Default false: the baseline
  // pipeline animates entities in place without AI/physics, so gravity is
  // off by default to prevent unanchored entities from falling through the
  // world. Per-entity override lets ground-bound enemies opt into gravity
  // when AI/wander is added later.
  readonly gravity?: boolean;
  readonly animations: Readonly<Record<string, AnimatedEntityAnimConfig>>;
  // Optional behavior block. Presence of this field is the one signal the
  // EntityFactory uses to instantiate Enemy vs AnimatedEntity. Absence ==
  // pure-decoration entity (chests, ambient animals, traps).
  readonly behavior?: AnimatedEntityBehaviorConfig;
}

export type EntityRegistry = Readonly<Record<string, AnimatedEntityConfig>>;
