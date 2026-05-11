import Phaser from 'phaser';
import { ENTITY_DEPTH } from '../constants';
import { getSpriteAnchor } from '../sprites/characterLoader';
import {
  entityAnimFullKey,
  getEntityRegistryEntry,
} from './entityRegistryLoader';
import type { AnimatedEntityConfig } from './entityRegistryTypes';

// Generic animated decoration entity driven by the entityRegistry JSON.
// Mirrors Player's anchor-and-body wiring but with no input, no combat,
// no overlays — just plays an animation in place at its LDtk-placed
// position. The whole class exists to turn "this LDtk identifier is
// animated" into "a Phaser sprite running an animation" without N
// hand-written subclasses, so per-entity behavior lives in JSON.
export class AnimatedEntity extends Phaser.Physics.Arcade.Sprite {
  declare body: Phaser.Physics.Arcade.Body;

  private readonly identifier: string;
  protected readonly config: AnimatedEntityConfig;

  constructor(scene: Phaser.Scene, x: number, y: number, identifier: string) {
    const config = getEntityRegistryEntry(identifier);
    if (!config) {
      throw new Error(
        `AnimatedEntity: no registry entry for identifier "${identifier}"`,
      );
    }
    const initialKey = entityAnimFullKey(identifier, config.defaultAnimation);
    if (!scene.textures.exists(initialKey)) {
      throw new Error(
        `AnimatedEntity textures not loaded — expected key "${initialKey}". ` +
          'Did PreloadScene run preloadAllEntities before constructing?',
      );
    }
    super(scene, x, y, initialKey);
    this.identifier = identifier;
    this.config = config;

    scene.add.existing(this);
    scene.physics.add.existing(this);

    // Render above tile layers, mirroring the depth applied to Player in
    // GameScene. Without this, entities sit at depth 0 and disappear under
    // foreground tile layers (Foreground1/2/3 in this project's LDtk).
    this.setDepth(ENTITY_DEPTH);

    // applyAnimationAnchor uses the registry's physicsBody size each anim
    // swap; setting it once here is the steady-state default until the
    // first ANIMATION_START fires (which is immediately, from the play
    // below, so this is mostly a safety net).
    this.body.setSize(config.physicsBody.width, config.physicsBody.height);
    // Gravity defaults to false: the baseline pipeline animates entities
    // in place. Per-entity override via config.gravity lets ground-bound
    // enemies opt in later when AI/wander gets layered on.
    this.body.setAllowGravity(config.gravity === true);
    // Entities never push back against walls in the baseline. Disabling
    // immovable + collision keeps Phaser's broad-phase cheap when N
    // entities spawn across the world.
    this.body.setImmovable(false);

    this.on(
      Phaser.Animations.Events.ANIMATION_START,
      this.applyAnimationAnchor,
      this,
    );

    this.play(initialKey);
    // Random phase offset so a clutch of identical entities (e.g. a row
    // of crows) doesn't flap in lockstep. setProgress is a 0..1 cursor
    // into the current anim's duration; Phaser tolerates re-seeding the
    // same anim it just started playing.
    this.anims.setProgress(Math.random());
  }

  // Plays a named animation from this entity's config. Returns false when
  // the animation is not in this entity's config — graceful degradation
  // for partial-anim entities (e.g. The_hive has only idle + death). The
  // baseline never calls this from outside, but the hook is here so a
  // future behavior layer can drive idle ↔ walk transitions without
  // having to re-do the registry lookup itself.
  playLogical(animKey: string): boolean {
    if (!(animKey in this.config.animations)) return false;
    const fullKey = entityAnimFullKey(this.identifier, animKey);
    this.play(fullKey);
    return true;
  }

  getIdentifier(): string {
    return this.identifier;
  }

  // Flips the sprite horizontally and re-applies the anchor so the physics
  // body offset stays correct in world space. Mirrors Player.setFacing — kept
  // separate (rather than promoting to a base class) because AnimatedEntity
  // is the only common ancestor and exposing this here lets Enemy face the
  // player without touching the private anchor handler.
  setFacing(faceLeft: boolean): void {
    if (this.flipX === faceLeft) return;
    this.setFlipX(faceLeft);
    const currentAnim = this.anims.currentAnim;
    if (currentAnim) {
      this.applyAnimationAnchor(currentAnim);
    }
  }

  private applyAnimationAnchor(animation: Phaser.Animations.Animation): void {
    const { width: bodyW, height: bodyH } = this.config.physicsBody;
    const {
      originX,
      originY,
      bodySourceWidth,
      bodySourceHeight,
      bodyOffsetX,
      bodyOffsetY,
      displayScale,
    } = getSpriteAnchor(animation.key, bodyW, bodyH, this.flipX);
    this.setOrigin(originX, originY);
    this.setScale(displayScale);
    this.body.setSize(bodySourceWidth, bodySourceHeight);
    this.body.setOffset(bodyOffsetX, bodyOffsetY);
  }
}
