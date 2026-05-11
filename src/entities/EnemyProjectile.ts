import Phaser from 'phaser';
import { PROJECTILE_MAX_LIFETIME_MS } from '../constants';

export interface EnemyProjectileSpawnOptions {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  // Per-shot damage, copied off the spawning enemy's attack.damage so the
  // projectile is self-contained and the enemy can be destroyed mid-flight
  // without losing the data needed to apply damage to the player.
  damage: number;
  // Full Phaser animation keys (already prefixed via entityAnimFullKey) so
  // multiple enemy types can share this class with their own projectile art.
  idleAnimKey: string;
  explodeAnimKey: string;
}

// Player-targeting projectile fired by enemies. Symmetric with the player's
// Projectile (terrain collider → onImpact, world-bounds → onImpact, lifetime
// cap, body disabled on impact to prevent multi-hit ticks) but with two
// per-instance fields — damage and the entity-namespaced animation keys —
// so any ranged enemy type can spawn one without a dedicated subclass.
export class EnemyProjectile extends Phaser.Physics.Arcade.Sprite {
  declare body: Phaser.Physics.Arcade.Body;

  private exploded = false;
  private lifetimeTimer: Phaser.Time.TimerEvent | null = null;
  private readonly damage: number;
  private readonly idleAnimKey: string;
  private readonly explodeAnimKey: string;
  private readonly worldBoundsHandler: (
    body: Phaser.Physics.Arcade.Body,
  ) => void;

  constructor(scene: Phaser.Scene, options: EnemyProjectileSpawnOptions) {
    if (!scene.textures.exists(options.idleAnimKey)) {
      throw new Error(
        `EnemyProjectile idle texture missing: "${options.idleAnimKey}". ` +
          'Did the entity registry validator miss this key, or is the texture not preloaded?',
      );
    }
    super(scene, options.x, options.y, options.idleAnimKey);
    this.damage = options.damage;
    this.idleAnimKey = options.idleAnimKey;
    this.explodeAnimKey = options.explodeAnimKey;

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.body.setAllowGravity(false);
    // Bounce 0,0 + worldbounds-event so the projectile halts cleanly when it
    // leaves the playfield and our handler swaps to explode. Matches the
    // player Projectile's setup so behavior is symmetric.
    this.body.setCollideWorldBounds(true, 0, 0, true);

    this.body.setVelocity(options.velocityX, options.velocityY);
    const angle = Math.atan2(options.velocityY, options.velocityX);
    this.setRotation(angle);
    // Mirror Y when aiming into the left half-plane so the sprite never
    // renders upside-down — same convention as the player Projectile.
    this.setFlipY(Math.abs(angle) > Math.PI / 2);

    this.play(this.idleAnimKey);

    this.lifetimeTimer = scene.time.delayedCall(
      PROJECTILE_MAX_LIFETIME_MS,
      () => this.onImpact(),
    );

    this.worldBoundsHandler = (body) => {
      if (body !== this.body) return;
      this.onImpact();
    };
    scene.physics.world.on(
      Phaser.Physics.Arcade.Events.WORLD_BOUNDS,
      this.worldBoundsHandler,
    );

    this.once(Phaser.GameObjects.Events.DESTROY, () => {
      scene.physics.world.off(
        Phaser.Physics.Arcade.Events.WORLD_BOUNDS,
        this.worldBoundsHandler,
      );
      if (this.lifetimeTimer) {
        this.lifetimeTimer.remove(false);
        this.lifetimeTimer = null;
      }
    });
  }

  getDamage(): number {
    return this.damage;
  }

  hasExploded(): boolean {
    return this.exploded;
  }

  onImpact(): void {
    if (this.exploded) return;
    this.exploded = true;

    if (this.lifetimeTimer) {
      this.lifetimeTimer.remove(false);
      this.lifetimeTimer = null;
    }

    this.setVelocity(0, 0);
    // Disabling the body removes it from Arcade's overlap lookups so further
    // per-frame overlap callbacks against the player stop firing — without
    // this, the projectile keeps overlapping during the explode animation
    // and stacks damage ticks, deleting the player in one shot.
    this.body.enable = false;

    this.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
      this.destroy();
    });
    this.play(this.explodeAnimKey);
  }
}
