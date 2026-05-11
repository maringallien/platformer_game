import Phaser from 'phaser';
import { PROJECTILE_MAX_LIFETIME_MS } from '../constants';
import {
  projectileAnimKey,
  type GunslingerProjectileMode,
} from '../sprites/characterLoader';

export interface ProjectileSpawnOptions {
  x: number;
  y: number;
  mode: GunslingerProjectileMode;
  velocityX: number;
  velocityY: number;
}

export class Projectile extends Phaser.Physics.Arcade.Sprite {
  declare body: Phaser.Physics.Arcade.Body;

  private exploded = false;
  private lifetimeTimer: Phaser.Time.TimerEvent | null = null;
  private readonly mode: GunslingerProjectileMode;
  private readonly worldBoundsHandler: (
    body: Phaser.Physics.Arcade.Body,
  ) => void;

  constructor(scene: Phaser.Scene, options: ProjectileSpawnOptions) {
    const idleKey = projectileAnimKey(options.mode, 'idle');
    if (!scene.textures.exists(idleKey)) {
      throw new Error(
        `Projectile idle texture missing: "${idleKey}". ` +
          'Did PreloadScene register projectile animations?',
      );
    }
    super(scene, options.x, options.y, idleKey);
    this.mode = options.mode;

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.body.setAllowGravity(false);
    // Bounce 0,0 so worldbounds collision halts the projectile cleanly
    // before our handler swaps to the explode animation. The 4th arg enables
    // the worldbounds event for this body.
    this.body.setCollideWorldBounds(true, 0, 0, true);

    this.body.setVelocity(options.velocityX, options.velocityY);
    // Rotate to face the velocity direction; mirror Y when aiming into the
    // left half-plane so the sprite never renders upside-down (mirrors the
    // PlayerGun's flipY-when-aimed-left convention).
    const angle = Math.atan2(options.velocityY, options.velocityX);
    this.setRotation(angle);
    this.setFlipY(Math.abs(angle) > Math.PI / 2);

    this.play(idleKey);

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
    // Disabling the body removes it from Arcade's overlap/collision lookups,
    // so further per-frame overlap callbacks against this projectile stop
    // firing. Without this, the projectile keeps overlapping its target for
    // the duration of the explode animation (many frames) and stacks damage
    // ticks — a single shot then kills enemies in one hit regardless of HP.
    this.body.enable = false;

    const explodeKey = projectileAnimKey(this.mode, 'explode');
    this.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
      this.destroy();
    });
    this.play(explodeKey);
  }
}
