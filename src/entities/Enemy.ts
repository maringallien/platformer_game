import Phaser from 'phaser';
import { AnimatedEntity } from './AnimatedEntity';
import type { EnemyProjectileSpawnOptions } from './EnemyProjectile';
import {
  entityAnimFullKey,
  getEntityBehavior,
} from './entityRegistryLoader';
import type {
  AnimatedEntityAttackConfig,
  AnimatedEntityBehaviorConfig,
} from './entityRegistryTypes';
import { Player } from './Player';

export type EnemyState =
  | 'idle'
  | 'chase'
  | 'attack'
  | 'recover'
  | 'hurt'
  | 'dead';

// Knockback applied on hurt. Smaller than the player's because enemies are
// typically smaller/lighter; tweak per-entity later if it feels wrong.
const ENEMY_HURT_KNOCKBACK_X = 80;
const ENEMY_HURT_KNOCKBACK_Y = -120;
// Duration of the hurt state. Decoupled from animation length because (a)
// many entities lack a take_hit sheet so ANIMATION_COMPLETE never fires, and
// (b) hurt anim lengths vary widely between entities — a uniform window
// keeps hit feedback consistent. After this window the entity zeros its
// X velocity and resumes idle.
const HURT_DURATION_MS = 250;
// Jump velocity for chase-time obstacle hops. Solving v² = 2·g·h with
// g = 800 (project gravity) and h = 2 tiles + margin → 40 px gives
// v ≈ 253 px/s. -260 keeps a comfortable buffer so a 2-tile wall is cleared
// without scraping; the chase X velocity keeps the body moving forward
// during the arc so it lands on the far side.
const ENEMY_JUMP_VELOCITY = -260;

// Structural interface so Enemy doesn't need to import GameScene (avoids a
// circular dependency between Enemy ↔ GameScene). GameScene implements every
// member directly.
interface EnemyHelperScene {
  spawnEnemyProjectile(options: EnemyProjectileSpawnOptions): void;
  // True when the world-pixel segment from (x1,y1) to (x2,y2) intersects a
  // solid collision tile. Used to gate chase and ranged-attack initiation.
  isLineBlocked(x1: number, y1: number, x2: number, y2: number): boolean;
  // True iff a solid collision tile exists at the given world coords. Used
  // for obstacle detection: enemy chase samples a point just ahead/up to
  // decide whether to jump.
  isTileSolidAt(x: number, y: number): boolean;
}

// Animated entity that gains health, damage, and a behavior block. Owns the
// AI state machine: when the player is within range, plays the configured
// attack animation and applies damage on the configured frame — melee via a
// transient overlapRect hitbox, ranged/magic via an EnemyProjectile aimed
// at the player. Multi-attack bosses authored with `attackPool` pick a
// random eligible attack per cycle; the `contact` type damages on body
// overlap (no animation), and `heal` self-casts when HP falls below a
// configurable fraction of max.
export class Enemy extends AnimatedEntity {
  declare body: Phaser.Physics.Arcade.Body;

  private readonly behavior: AnimatedEntityBehaviorConfig;
  // Flattened attack list: either the single `attack` from the registry, or
  // every entry in `attackPool`. Chase fields (aggressive / chaseRange /
  // moveSpeed / walkAnimation) are read from `attacks[0]` — multi-attack
  // bosses should put the chase-bearing entry first.
  private readonly attacks: ReadonlyArray<AnimatedEntityAttackConfig>;
  private health: number;
  private enemyState: EnemyState = 'idle';
  // Wall-clock timestamp at which the post-attack recover window ends. Set
  // when an attack animation completes; used to gate the next attack cycle.
  private cooldownUntil = 0;
  // Facing direction: 1 = right, -1 = left. Updated each tick to face the
  // player, except while an attack is committed (facing locks at attack
  // entry so the hitbox direction matches the animation the player sees).
  private facingDirection: 1 | -1 = 1;
  // Pending hurt-state exit timer. Tracked so repeated hits can cancel the
  // old timer and start a fresh window, preventing the entity from snapping
  // back to idle mid-stagger.
  private hurtTimer: Phaser.Time.TimerEvent | null = null;
  // Set to true the first frame the attack animation reaches its configured
  // damage frame — keeps the per-frame ANIMATION_UPDATE handler from firing
  // damage more than once per swing.
  private attackFired = false;
  // The attack chosen for the in-flight swing. null when idle/chase/recover.
  // Stored so the ANIMATION_UPDATE/ANIMATION_COMPLETE handlers know which
  // damage frame and which animation key to watch for — pool-based bosses
  // can't read `behavior.attack` for this because they have many.
  private currentAttack: AnimatedEntityAttackConfig | null = null;
  // Per-attack contact cooldown timestamps. Contact attacks damage on body
  // overlap with the player and use their own cooldown to prevent tick-storms;
  // tracked per-attack so multiple contact entries (rare, but possible) don't
  // share a single timer.
  private readonly contactCooldowns = new Map<
    AnimatedEntityAttackConfig,
    number
  >();
  // Captured during update(player) so the asynchronous ANIMATION_UPDATE /
  // ANIMATION_COMPLETE handlers have something to aim a projectile at. Null
  // until the first update tick.
  private playerRef: Player | null = null;

  constructor(scene: Phaser.Scene, x: number, y: number, identifier: string) {
    super(scene, x, y, identifier);
    const behavior = getEntityBehavior(identifier);
    if (!behavior) {
      // Defensive: EntityFactory should only construct Enemy for entries
      // that have a behavior block. If we reach here without one, the
      // factory branching is broken.
      throw new Error(
        `Enemy: identifier "${identifier}" has no behavior block — should have been spawned as AnimatedEntity`,
      );
    }
    this.behavior = behavior;
    this.health = behavior.health;
    // attackPool wins when both are set — the schema treats `attack` as the
    // single-attack shorthand. Empty list is valid (passive enemies).
    this.attacks =
      behavior.attackPool ??
      (behavior.attack ? [behavior.attack] : []);

    if (behavior.immovable) {
      // Anchor the entity to its LDtk spawn position. Gravity off so it
      // doesn't drift downward; immovable so player collisions can't shove
      // it sideways either. takeDamage also skips knockback for these.
      this.body.setAllowGravity(false);
      this.body.setImmovable(true);
    }

    this.on(
      Phaser.Animations.Events.ANIMATION_UPDATE,
      this.onAnimUpdate,
      this,
    );
    this.on(
      Phaser.Animations.Events.ANIMATION_COMPLETE,
      this.onAnimComplete,
      this,
    );

    // Cancel any pending hurt timer when the sprite is destroyed (e.g. on
    // HMR teardown or death-anim complete). Without this, the delayedCall
    // can fire against a destroyed body and throw.
    this.once(Phaser.GameObjects.Events.DESTROY, () => {
      if (this.hurtTimer) {
        this.hurtTimer.remove(false);
        this.hurtTimer = null;
      }
    });
  }

  getHealth(): number {
    return this.health;
  }

  getState(): EnemyState {
    return this.enemyState;
  }

  getBehavior(): AnimatedEntityBehaviorConfig {
    return this.behavior;
  }

  isDead(): boolean {
    return this.enemyState === 'dead';
  }

  // Called by GameScene.update() each frame. Drives the AI state machine.
  // Inert when the entity has no attack — passive enemies still spawn as
  // killable targets without attacking back.
  update(player: Player): void {
    if (this.enemyState === 'dead' || this.enemyState === 'hurt') return;
    if (this.attacks.length === 0) return;

    this.playerRef = player;

    // Contact attacks run independently of the swing state machine — fire
    // first so a chase-and-bump enemy (wasp) damages on contact even mid-
    // recover. The player's own invuln window prevents tick-storms.
    this.applyContactDamage(player);

    const dx = player.x - this.x;
    const dy = player.y - this.y;
    const dist = Math.hypot(dx, dy);

    // Face the player whenever we're free to — locked while attacking so
    // the committed swing's hitbox direction matches what the animation
    // showed.
    if (this.enemyState !== 'attack') {
      this.facingDirection = dx >= 0 ? 1 : -1;
      this.setFacing(this.facingDirection === -1);
    }

    if (this.enemyState === 'recover') {
      if (this.scene.time.now < this.cooldownUntil) return;
      this.enterIdle();
      // Fall through so a player still in range triggers a fresh attack
      // this same tick rather than burning a frame in idle.
    }

    if (this.enemyState === 'attack') {
      // Don't drift during the swing. Immovable bodies already have zero
      // velocity from physics, but the explicit zero keeps the velocity
      // model uniform across all enemies.
      if (!this.behavior.immovable) {
        this.setVelocityX(0);
      }
      return;
    }

    const pick = this.pickAttack(dist);
    if (pick) {
      // Ranged/magic attacks need a clear line to the player — firing at a
      // wall is a wasted swing and looks broken. Melee swings still commit
      // through walls: the hitbox is short and usually can't reach the
      // player through a 16 px tile, and short-circuiting melee here would
      // make wall-hugging trivially exploitable.
      if (pick.type === 'ranged' || pick.type === 'magic') {
        const helper = this.scene as unknown as EnemyHelperScene;
        if (helper.isLineBlocked(this.x, this.y, player.x, player.y)) {
          if (this.enemyState !== 'idle') this.enterIdle();
          return;
        }
      }
      this.enterAttackState(pick);
      return;
    }

    // No eligible attack — try to chase. Chase fields live on attacks[0]
    // (the lead/default attack); pool-based bosses authoring multiple
    // attacks should put the chase-bearing entry first.
    const chaseLead = this.attacks[0];
    const canChase =
      chaseLead.aggressive &&
      chaseLead.chaseRange != null &&
      chaseLead.moveSpeed != null &&
      !this.behavior.immovable;

    if (canChase && dist <= chaseLead.chaseRange!) {
      const helper = this.scene as unknown as EnemyHelperScene;
      // Chase is gated on line-of-sight so enemies don't pathologically
      // shove against walls between them and the player.
      if (helper.isLineBlocked(this.x, this.y, player.x, player.y)) {
        if (this.enemyState !== 'idle') this.enterIdle();
        return;
      }
      if (this.enemyState !== 'chase') {
        this.enemyState = 'chase';
        const walkAnim = chaseLead.walkAnimation;
        if (walkAnim) this.playLogical(walkAnim);
      }
      // Hop short walls (≤ 2 tiles) so a ground-bound chaser can follow
      // the player up small steps. Air-borne enemies (gravity off) bypass
      // this — they just translate horizontally.
      if (this.shouldJumpOverObstacle()) {
        this.setVelocityY(ENEMY_JUMP_VELOCITY);
      }
      this.setVelocityX(chaseLead.moveSpeed! * this.facingDirection);
      return;
    }

    if (this.enemyState !== 'idle') {
      this.enterIdle();
    }
  }

  // Public damage entry point. Called by GameScene's projectile-overlap
  // handler and by Player.applySwordHits during melee. Source coords are
  // used to compute knockback direction.
  takeDamage(damage: number, sourceX: number, _sourceY: number): void {
    if (this.enemyState === 'dead') return;
    this.health = Math.max(0, this.health - damage);

    if (!this.behavior.immovable) {
      const knockbackDir: 1 | -1 = this.x >= sourceX ? 1 : -1;
      this.setVelocityX(ENEMY_HURT_KNOCKBACK_X * knockbackDir);
      if (this.body.allowGravity) {
        this.setVelocityY(ENEMY_HURT_KNOCKBACK_Y);
      }
    }

    if (this.health <= 0) {
      this.enterDeadState();
      return;
    }

    this.enemyState = 'hurt';
    // Reset attack-frame guard so the next attack post-recovery can fire
    // its damage frame again.
    this.attackFired = false;
    this.currentAttack = null;
    if (this.behavior.hurtAnimation) {
      this.playLogical(this.behavior.hurtAnimation);
    }

    // Replace any pending hurt timer so back-to-back hits start a fresh
    // window instead of letting the first one snap us back to idle mid-flinch.
    if (this.hurtTimer) {
      this.hurtTimer.remove(false);
    }
    this.hurtTimer = this.scene.time.delayedCall(HURT_DURATION_MS, () => {
      this.hurtTimer = null;
      if (this.enemyState !== 'hurt') return;
      this.enterIdle();
    });
  }

  // Picks a non-contact attack the enemy is eligible to use right now.
  // Heal only eligible when HP < threshold so bosses save it for when
  // they're bloodied. Melee/ranged/magic eligible when dist <= range. If
  // multiple are eligible (e.g. several melee attacks of overlapping
  // range), one is picked uniformly at random — gives bosses a varied
  // attack rhythm without scripting a sequence.
  private pickAttack(dist: number): AnimatedEntityAttackConfig | null {
    const eligible: AnimatedEntityAttackConfig[] = [];
    for (const attack of this.attacks) {
      if (attack.type === 'contact') continue;
      if (attack.type === 'heal') {
        const threshold = attack.healThreshold ?? 0.5;
        if (this.health / this.behavior.health >= threshold) continue;
        eligible.push(attack);
        continue;
      }
      if (attack.range != null && dist <= attack.range) {
        eligible.push(attack);
      }
    }
    if (eligible.length === 0) return null;
    return eligible[Math.floor(Math.random() * eligible.length)];
  }

  private enterAttackState(attack: AnimatedEntityAttackConfig): void {
    this.enemyState = 'attack';
    this.attackFired = false;
    this.currentAttack = attack;
    if (!this.behavior.immovable) {
      this.setVelocityX(0);
    }
    // Validator guarantees animation is set for melee/ranged/magic/heal;
    // contact never enters this state.
    if (attack.animation != null) {
      this.playLogical(attack.animation);
    }
  }

  private enterIdle(): void {
    this.enemyState = 'idle';
    this.currentAttack = null;
    if (!this.behavior.immovable) {
      this.body.setVelocityX(0);
    }
    // Fall back to the registry's defaultAnimation rather than hardcoding
    // 'idle' — some entities (e.g. Evil_crow) use other keys like 'take_off'
    // for their resting pose, and 'idle' would silently no-op there.
    this.playLogical(this.config.defaultAnimation);
  }

  private enterDeadState(): void {
    this.enemyState = 'dead';
    this.currentAttack = null;
    // Disable further collisions so the corpse can't keep damaging the
    // player and projectiles pass through harmlessly.
    this.body.checkCollision.none = true;
    this.body.setVelocity(0, 0);
    const deathAnim = this.behavior.deathAnimation ?? 'death';
    const played = this.playLogical(deathAnim);
    if (!played) {
      // No death animation registered — destroy immediately so the corpse
      // doesn't linger on its last hurt/idle frame forever.
      this.destroy();
    }
  }

  // Per-frame attack-animation hook: fires the configured damage frame
  // exactly once per swing. Gated on enemyState so a hurt-interrupt or
  // death mid-attack short-circuits without applying damage.
  private onAnimUpdate(
    animation: Phaser.Animations.Animation,
    frame: Phaser.Animations.AnimationFrame,
  ): void {
    if (this.enemyState !== 'attack') return;
    if (this.attackFired) return;
    const attack = this.currentAttack;
    if (!attack || attack.animation == null || attack.frame == null) return;
    const expectedKey = entityAnimFullKey(this.getIdentifier(), attack.animation);
    if (animation.key !== expectedKey) return;
    if (frame.index < attack.frame) return;
    this.fireAttackEffect(attack);
    this.attackFired = true;
  }

  private onAnimComplete(animation: Phaser.Animations.Animation): void {
    if (this.enemyState === 'dead') {
      const deathAnim = this.behavior.deathAnimation ?? 'death';
      const deathFullKey = entityAnimFullKey(this.getIdentifier(), deathAnim);
      if (animation.key === deathFullKey) {
        this.destroy();
      }
      return;
    }

    const attack = this.currentAttack;
    if (this.enemyState === 'attack' && attack && attack.animation != null) {
      const attackFullKey = entityAnimFullKey(this.getIdentifier(), attack.animation);
      if (animation.key === attackFullKey) {
        this.enemyState = 'recover';
        this.cooldownUntil = this.scene.time.now + attack.cooldownMs;
        this.currentAttack = null;
        this.playLogical(this.config.defaultAnimation);
      }
    }
  }

  // Dispatch to the appropriate per-frame effect for the in-flight attack.
  // Contact attacks never reach here (they don't enter attack state); the
  // remaining types are the ones validated to have animation + frame.
  private fireAttackEffect(attack: AnimatedEntityAttackConfig): void {
    if (attack.type === 'melee') {
      this.fireMeleeAttack(attack);
      return;
    }
    if (attack.type === 'heal') {
      this.applyHeal(attack);
      return;
    }
    // ranged / magic — same delivery, different art
    this.fireProjectileAttack(attack);
  }

  private fireMeleeAttack(attack: AnimatedEntityAttackConfig): void {
    const hb = attack.hitbox;
    const damage = attack.damage;
    if (!hb || damage == null) {
      // Validator guarantees both — defend in case the schema drifts.
      return;
    }
    const facing = this.facingDirection;
    const hx =
      facing === 1
        ? this.x + hb.offsetX
        : this.x - hb.offsetX - hb.width;
    const hy = this.y + hb.offsetY - hb.height / 2;
    const overlaps = this.scene.physics.overlapRect(
      hx,
      hy,
      hb.width,
      hb.height,
      true,
      false,
    ) as Phaser.Physics.Arcade.Body[];
    for (const body of overlaps) {
      const obj = body.gameObject;
      if (obj instanceof Player) {
        obj.hurt(damage, this.x, this.y);
        return;
      }
    }
  }

  private fireProjectileAttack(attack: AnimatedEntityAttackConfig): void {
    if (!this.playerRef) return;
    const idleKey = attack.projectileAnimIdle;
    const explodeKey = attack.projectileAnimExplode;
    const speed = attack.projectileSpeed;
    const damage = attack.damage;
    if (
      idleKey == null ||
      explodeKey == null ||
      speed == null ||
      damage == null
    ) {
      return;
    }
    const dx = this.playerRef.x - this.x;
    const dy = this.playerRef.y - this.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    const vx = (dx / len) * speed;
    const vy = (dy / len) * speed;
    const helper = this.scene as unknown as EnemyHelperScene;
    helper.spawnEnemyProjectile({
      x: this.x,
      y: this.y,
      velocityX: vx,
      velocityY: vy,
      damage,
      idleAnimKey: entityAnimFullKey(this.getIdentifier(), idleKey),
      explodeAnimKey: entityAnimFullKey(this.getIdentifier(), explodeKey),
    });
  }

  // Self-cast HP restore on the heal animation's configured frame. Clamps
  // to behavior.health (max). Mirrors the takeDamage clamp at the bottom
  // edge so the boss can't over-heal beyond its registered cap.
  private applyHeal(attack: AnimatedEntityAttackConfig): void {
    const amount = attack.heal;
    if (amount == null) return;
    this.health = Math.min(this.behavior.health, this.health + amount);
  }

  // Iterates every contact-type entry and applies damage to the player on
  // body overlap, gated per-attack by cooldown. The player's own invuln
  // window absorbs the rest of the noise — without it, an enemy stuck
  // overlapping the player would tick every frame the cooldown allows.
  private applyContactDamage(player: Player): void {
    for (const attack of this.attacks) {
      if (attack.type !== 'contact') continue;
      const damage = attack.damage;
      if (damage == null) continue;
      const ready = this.contactCooldowns.get(attack) ?? 0;
      if (this.scene.time.now < ready) continue;
      if (!this.scene.physics.world.overlap(this, player)) continue;
      player.hurt(damage, this.x, this.y);
      this.contactCooldowns.set(
        attack,
        this.scene.time.now + attack.cooldownMs,
      );
    }
  }

  // True when a chasing ground enemy is standing in front of a wall ≤ 2
  // tiles tall and should hop over it. Gravity-off enemies skip this
  // entirely — they have no useful "jump" semantics. Sampling at
  // body.bottom - 8 avoids hitting the floor tile the enemy is standing
  // on; the +4 px offset ahead avoids self-collision with the body's own
  // bounding box. probeY - 32 (two tiles up + one tile clearance) must
  // be empty so a 3-tile wall is rejected.
  private shouldJumpOverObstacle(): boolean {
    if (!this.body.allowGravity) return false;
    if (!this.body.blocked.down) return false;
    const helper = this.scene as unknown as EnemyHelperScene;
    const aheadX =
      this.facingDirection === 1
        ? this.body.right + 4
        : this.body.left - 4;
    const probeY = this.body.bottom - 8;
    if (!helper.isTileSolidAt(aheadX, probeY)) return false;
    if (helper.isTileSolidAt(aheadX, probeY - 32)) return false;
    return true;
  }
}
