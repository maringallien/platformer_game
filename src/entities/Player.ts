import Phaser from 'phaser';
import {
  PLAYER_RUN_SPEED,
  PLAYER_JUMP_VELOCITY,
  JUMP_CUT_VELOCITY_MULTIPLIER,
  FALL_BONUS_GRAVITY,
  PLAYER_DASH_SPEED,
  PLAYER_DASH_DURATION_MS,
  PLAYER_MAX_FALL_SPEED,
  PLAYER_ROLL_SPEED,
  WALL_SLIDE_MAX_VY,
  WHEEL_COOLDOWN_MS,
  PROJECTILE_GUN1_SPEED,
  PROJECTILE_GUN2_SPEED,
  PROJECTILE_BARREL_LENGTH_PX,
  GUN_OVERLAY_PIVOT_OFFSET_X,
  GUN_OVERLAY_PIVOT_OFFSET_Y,
  GUNSLINGER_GUN1_FIRE_RATE_MULTIPLIER,
  PLAYER_MAX_HEALTH,
  PLAYER_INVULN_MS,
  PLAYER_HURT_KNOCKBACK_X,
  PLAYER_HURT_KNOCKBACK_Y,
  SWORD_ATTACK_DAMAGE,
  SWORD_ATTACK_REACH_X,
  SWORD_ATTACK_REACH_Y,
} from '../constants';
import { Enemy } from './Enemy';
import {
  animKey,
  fullKeysForLogical,
  getAnimationNaturalDurationMs,
  getAnimationSourceMode,
  getAnimationStage,
  getSpriteAnchor,
  gunOverlayAnimKey,
  isActionAvailable,
  magicAttackAnimKey,
  magicAttackKeySet,
  MODE_ORDER,
} from '../sprites/characterLoader';
import type {
  CharacterModeId,
  LogicalAnimationKey,
} from '../sprites/characterTypes';
import type { ProjectileSpawnOptions } from './Projectile';
import { PlayerGun } from './PlayerGun';

// Structural interface so Player doesn't need to import GameScene (avoids a
// circular dependency between Player ↔ GameScene).
interface ProjectileSpawnerScene {
  spawnProjectile(options: ProjectileSpawnOptions): void;
}

interface ProjectileFireConfig {
  // Overlay anim key (the gun sprite). The body has no attack1 anymore —
  // firing is overlay-only, so the lifecycle (fire-frame trigger, complete
  // event) is sourced from the overlay's animation events.
  readonly overlayKey: string;
  readonly fireFrame: number;
  readonly speed: number;
  readonly mode: 'gunslinger_gun1' | 'gunslinger_gun2';
  // Overlay play duration (ms). Undefined = use the registry's natural
  // duration. Set for gun1 to apply the fire-rate multiplier, which also
  // shortens the locked-attack window so the player can fire again sooner.
  readonly overlayDurationMs?: number;
}

const PHYSICS_BODY_WIDTH = 16;
const PHYSICS_BODY_HEIGHT = 24;
const ROLL_ATTACK_STEP = 1;
const ROLL_ATTACK_STOP_FRAME = 4;
const GUNSLINGER_ROLL_STOP_FRAME = 7;
// Gunslinger roll has a 2-frame wind-up before any lateral travel begins, so
// velocity is held at zero until the body has visibly committed to the dive.
const GUNSLINGER_ROLL_LATERAL_START_FRAME = 2;
const COMBO_FIRST_STEP = 2;
const MAX_COMBO_STEP = 5;
const TELEPORT_ATTACK_STEP = 6;
const TELEPORT_DISTANCE_PX = 150;
const LEFT_MOUSE_BUTTON = 0;
// Debug fly mode: 4-directional WASD movement at constant speed, gravity and
// tile collision disabled. Lets the camera be panned across the whole world
// to verify every LDtk level renders, without bridging gaps between levels.
const FLY_SPEED = 400;

// Mode-aware key sets for onAnimationComplete dispatch. Built once at module
// load from the character registries.
const ATTACK_KEYS: ReadonlySet<string> = new Set<string>([
  ...fullKeysForLogical('attack1'),
  ...fullKeysForLogical('attack2'),
  ...fullKeysForLogical('attack3'),
  ...fullKeysForLogical('attack4'),
  ...fullKeysForLogical('attack5'),
  ...fullKeysForLogical('attack6'),
  ...magicAttackKeySet(),
]);
const DASH_KEYS: ReadonlySet<string> = fullKeysForLogical('dash');
const ROLL_KEYS: ReadonlySet<string> = fullKeysForLogical('roll');
const BLOCK_KEYS: ReadonlySet<string> = fullKeysForLogical('block');
const LEDGE_CLIMB_KEYS: ReadonlySet<string> = fullKeysForLogical('ledge_climb');
const TAKE_HIT_KEYS: ReadonlySet<string> = fullKeysForLogical('take_hit');
const DEATH_KEYS: ReadonlySet<string> = fullKeysForLogical('death');

// Event emitted on the Player sprite when health hits zero. GameScene listens
// to schedule a restart after the death animation has had time to play.
export const PLAYER_DIED_EVENT = 'player-died';

function requireAnimKey(
  mode: CharacterModeId,
  logical: LogicalAnimationKey,
): string {
  const key = animKey(mode, logical);
  if (!key) {
    throw new Error(`Missing animation: ${mode}.${logical}`);
  }
  return key;
}

// Teleport always uses sword_master attack6 (the only mode that has it).
const TELEPORT_ANIM_KEY = requireAnimKey('sword_master', 'attack6');

function buildProjectileFireConfigs(): ReadonlyMap<
  'gunslinger_gun1' | 'gunslinger_gun2',
  ProjectileFireConfig
> {
  const map = new Map<
    'gunslinger_gun1' | 'gunslinger_gun2',
    ProjectileFireConfig
  >();
  // Firing is overlay-only — the gun sprite's attack1 is the visible gunshot,
  // so its "fire" stage frame index drives projectile spawn timing and its
  // animation-complete event ends the locked-attack window.
  const gun1OverlayKey = gunOverlayAnimKey('gunslinger_gun1', 'attack1');
  const gun2OverlayKey = gunOverlayAnimKey('gunslinger_gun2', 'attack1');
  const gun1Stage = getAnimationStage(gun1OverlayKey, 'fire');
  const gun2Stage = getAnimationStage(gun2OverlayKey, 'fire');
  if (!gun1Stage || !gun2Stage) {
    throw new Error(
      `Missing "fire" stage on gunslinger overlay attack1. gun1=${gun1Stage}, gun2=${gun2Stage}. ` +
        'Did the animation registry get out of sync?',
    );
  }
  const gun1OverlayNatural = getAnimationNaturalDurationMs(gun1OverlayKey);
  if (gun1OverlayNatural == null) {
    throw new Error('Missing natural duration for gun1 overlay attack1');
  }
  map.set('gunslinger_gun1', {
    overlayKey: gun1OverlayKey,
    fireFrame: gun1Stage.startFrame,
    speed: PROJECTILE_GUN1_SPEED,
    mode: 'gunslinger_gun1',
    overlayDurationMs: gun1OverlayNatural / GUNSLINGER_GUN1_FIRE_RATE_MULTIPLIER,
  });
  map.set('gunslinger_gun2', {
    overlayKey: gun2OverlayKey,
    fireFrame: gun2Stage.startFrame,
    speed: PROJECTILE_GUN2_SPEED,
    mode: 'gunslinger_gun2',
  });
  return map;
}

type AttackKind = 'regular' | 'magic';

type PlayerVisualState =
  | 'idle'
  | 'run'
  | 'fall'
  | 'attack'
  | 'dash'
  | 'roll'
  | 'block'
  | 'wall_slide'
  | 'climb';
type MoveDirection = -1 | 0 | 1;
type LockedAction =
  | 'attack'
  | 'dash'
  | 'roll'
  | 'block'
  | 'climb'
  | 'hurt'
  | 'dead'
  | null;
type PointerHandler = (pointer: Phaser.Input.Pointer) => void;
type WheelHandler = (
  pointer: Phaser.Input.Pointer,
  currentlyOver: Phaser.GameObjects.GameObject[],
  deltaX: number,
  deltaY: number,
  deltaZ: number,
) => void;

interface LedgeTrigger {
  direction: MoveDirection;
  wallTop: number;
  wallEdgeX: number;
}

type ArcadeBody = Phaser.Physics.Arcade.Body | Phaser.Physics.Arcade.StaticBody;

export class Player extends Phaser.Physics.Arcade.Sprite {
  declare body: Phaser.Physics.Arcade.Body;

  private readonly keyW: Phaser.Input.Keyboard.Key;
  private readonly keyA: Phaser.Input.Keyboard.Key;
  private readonly keyS: Phaser.Input.Keyboard.Key;
  private readonly keyD: Phaser.Input.Keyboard.Key;
  private readonly keyF: Phaser.Input.Keyboard.Key;
  private readonly keyG: Phaser.Input.Keyboard.Key;
  // TODO(Phase 4): remove after enemy attacks are wired up. Debug-only hurt
  // trigger so Phase 1 can be exercised before enemies exist.
  private readonly keyH: Phaser.Input.Keyboard.Key;
  private readonly keyShift: Phaser.Input.Keyboard.Key;
  private readonly keySpace: Phaser.Input.Keyboard.Key;
  private readonly teleportAppearStartFrame: number;
  private readonly projectileFireConfigs: ReadonlyMap<
    'gunslinger_gun1' | 'gunslinger_gun2',
    ProjectileFireConfig
  >;
  private currentMode: CharacterModeId = 'sword_master';
  // Live only while currentMode is a gunslinger variant. Created on entry,
  // destroyed on exit so the overlay never lingers as an invisible sprite
  // during sword_master play.
  private playerGun: PlayerGun | null = null;
  private currentVisualState: PlayerVisualState = 'idle';
  private lockedAction: LockedAction = null;
  private attackCounter = 0;
  private queuedAttack = false;
  private teleportFired = false;
  private firedProjectile = false;
  private magicMode = false;
  private currentAttackKind: AttackKind = 'regular';
  private wasRightDown = false;
  private wallSlideDirection: MoveDirection = 0;
  // Captured at startRoll for gunslinger so the lateral velocity applied
  // mid-roll (after the wind-up frames) reflects the original commit, not
  // any cursor-driven flipX change that updateAimFacing made during the roll.
  private rollDirection: 1 | -1 = 1;
  private wheelCooldownUntil = 0;
  private flyMode = false;
  private health = PLAYER_MAX_HEALTH;
  private invulnerableUntil = 0;
  // Per-attack set of enemies already damaged by the current sword swing.
  // Each sword attack scans the forward hitbox every frame it's active; this
  // set prevents one swing from ticking damage repeatedly against the same
  // enemy. Cleared at startAttackAnim (and again when the lockedAction ends).
  private readonly swordHitTargets: Set<Enemy> = new Set();
  private readonly attackPointerHandler: PointerHandler;
  private readonly wheelHandler: WheelHandler;
  private readonly postUpdateHandler: () => void;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    const initialIdleKey = animKey('sword_master', 'idle');
    if (!initialIdleKey || !scene.textures.exists(initialIdleKey)) {
      throw new Error(
        `Sword master textures not loaded — expected key "${initialIdleKey}". ` +
          'Did PreloadScene run before this Player was constructed?',
      );
    }
    super(scene, x, y, initialIdleKey);

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.body.setSize(PHYSICS_BODY_WIDTH, PHYSICS_BODY_HEIGHT);
    this.setCollideWorldBounds(true);
    // Cap downward velocity below tile_size_px * fps so long falls can't
    // tunnel through floor tiles. Only the Y axis is constrained — leave the
    // default X cap intact so dash and run aren't clamped.
    this.body.maxVelocity.y = PLAYER_MAX_FALL_SPEED;
    this.on(
      Phaser.Animations.Events.ANIMATION_START,
      this.applyAnimationAnchor,
      this,
    );

    if (!scene.input.keyboard) {
      throw new Error('Keyboard input is not available');
    }
    scene.input.mouse?.disableContextMenu();
    const kb = scene.input.keyboard;
    this.keyW = kb.addKey(Phaser.Input.Keyboard.KeyCodes.W);
    this.keyA = kb.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyS = kb.addKey(Phaser.Input.Keyboard.KeyCodes.S);
    this.keyD = kb.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.keyF = kb.addKey(Phaser.Input.Keyboard.KeyCodes.F);
    this.keyG = kb.addKey(Phaser.Input.Keyboard.KeyCodes.G);
    this.keyH = kb.addKey(Phaser.Input.Keyboard.KeyCodes.H);
    this.keyShift = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);
    this.keySpace = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);

    const appearStage = getAnimationStage(TELEPORT_ANIM_KEY, 'appear');
    if (!appearStage) {
      throw new Error(
        `Missing "appear" stage for ${TELEPORT_ANIM_KEY}. ` +
          'Did the animation registry get out of sync?',
      );
    }
    this.teleportAppearStartFrame = appearStage.startFrame;

    this.projectileFireConfigs = buildProjectileFireConfigs();

    this.attackPointerHandler = (pointer) => {
      if (pointer.button === LEFT_MOUSE_BUTTON) {
        this.handleAttackInput();
      }
    };
    scene.input.on(Phaser.Input.Events.POINTER_DOWN, this.attackPointerHandler);

    this.wheelHandler = (_pointer, _over, _dx, dy) => {
      if (dy === 0) return;
      if (this.scene.time.now < this.wheelCooldownUntil) return;
      // Browser convention: wheel-up scrolls the page upward => deltaY < 0.
      // The user's spec is "scroll up advances the sequence".
      this.tryAdvanceMode(dy < 0 ? 1 : -1);
    };
    scene.input.on(Phaser.Input.Events.POINTER_WHEEL, this.wheelHandler);

    // Sync the gun in POST_UPDATE — by then Arcade physics has written the
    // body's resolved position back to sprite x/y. Doing it inside update()
    // (which runs before POST_UPDATE) reads the previous frame's sprite
    // position, so the gun trails the body by one frame; under gravity that
    // lag grows visibly each frame and the gun appears to detach mid-fall.
    this.postUpdateHandler = () => this.syncPlayerGun();
    scene.events.on(Phaser.Scenes.Events.POST_UPDATE, this.postUpdateHandler);

    this.once(Phaser.GameObjects.Events.DESTROY, () => {
      scene.input.off(
        Phaser.Input.Events.POINTER_DOWN,
        this.attackPointerHandler,
      );
      scene.input.off(Phaser.Input.Events.POINTER_WHEEL, this.wheelHandler);
      scene.events.off(
        Phaser.Scenes.Events.POST_UPDATE,
        this.postUpdateHandler,
      );
      this.destroyPlayerGun();
    });

    this.on(
      Phaser.Animations.Events.ANIMATION_COMPLETE,
      this.onAnimationComplete,
      this,
    );
    this.on(
      Phaser.Animations.Events.ANIMATION_UPDATE,
      this.onAnimationUpdate,
      this,
    );

    this.playLogical('idle');
  }

  getCurrentMode(): CharacterModeId {
    return this.currentMode;
  }

  // Programmatic mode swap, used by HMR snapshot/restore. Bypasses the wheel
  // cooldown and the body-bottom snap that tryAdvanceMode does — callers
  // restoring after a teardown have already set the player's position
  // explicitly, so re-snapping here would just stomp on it.
  setCurrentMode(mode: CharacterModeId): void {
    if (mode === this.currentMode) return;
    this.currentMode = mode;
    if (mode !== 'sword_master') {
      this.magicMode = false;
    }
    this.ensurePlayerGunForMode();
    this.applyModeChangeAnimation();
  }

  update(): void {
    this.updateInner();
    // Gun sync is handled in the scene's POST_UPDATE handler so it runs after
    // Arcade physics has written body positions back to sprite x/y — see the
    // constructor's postUpdateHandler registration for the rationale.
  }

  private updateInner(): void {
    if (this.lockedAction === 'dead') {
      // No input, no facing updates. Gravity still applies via the body's
      // own settings; the corpse settles wherever the knockback put it.
      return;
    }

    if (Phaser.Input.Keyboard.JustDown(this.keyG)) {
      this.toggleFlyMode();
    }
    if (this.flyMode) {
      this.updateFlyMode();
      return;
    }

    // Debug-only hurt trigger. Remove with this keyH binding in Phase 4
    // once real enemy attacks are wired up.
    if (Phaser.Input.Keyboard.JustDown(this.keyH)) {
      this.hurt(10, this.x - 50, this.y);
    }

    // Cursor-driven body facing in gunslinger mode. Runs before the rest of
    // update() so movement logic can still override velocity without fighting
    // facing — the in-mode setFacing call below is gated on sword_master.
    this.updateAimFacing();

    const rightDown = this.scene.input.activePointer.rightButtonDown();
    const rightJustPressed = rightDown && !this.wasRightDown;
    this.wasRightDown = rightDown;

    if (this.lockedAction !== 'climb') {
      this.body.setGravityY(
        this.body.velocity.y > 0 ? FALL_BONUS_GRAVITY : 0,
      );
    }

    // F toggles magic stance only in sword_master mode. Gunslinger modes have
    // no magic registry; F is a no-op there.
    if (
      Phaser.Input.Keyboard.JustDown(this.keyF) &&
      this.currentMode === 'sword_master'
    ) {
      this.magicMode = !this.magicMode;
    }

    // Gunslinger fires while moving / jumping: the attack animation plays as
    // an overlay but movement input still runs. Sword-master attacks freeze
    // the player in place via the locked-action branch below.
    const isGunslingerShooting =
      this.lockedAction === 'attack' && this.isGunslingerMode();

    if (this.lockedAction !== null && !isGunslingerShooting) {
      if (this.lockedAction === 'attack') {
        // Sword swings damage enemies via a per-frame overlap scan. Runs only
        // for sword_master modes; gunslinger fires its own projectiles.
        this.applySwordHits();
        if (this.isRollAttackInProgress()) {
          const frame = this.anims.currentFrame;
          if (frame && frame.index >= ROLL_ATTACK_STOP_FRAME) {
            this.setVelocityX(0);
          }
        } else {
          this.setVelocityX(0);
        }
      } else if (this.lockedAction === 'block') {
        if (!rightDown) {
          this.endLockedAction();
        } else {
          this.setVelocityX(0);
        }
      } else if (this.lockedAction === 'roll' && this.isGunslingerMode()) {
        const frame = this.anims.currentFrame;
        if (frame) {
          if (
            frame.index < GUNSLINGER_ROLL_LATERAL_START_FRAME ||
            frame.index >= GUNSLINGER_ROLL_STOP_FRAME
          ) {
            this.setVelocityX(0);
          } else {
            this.setVelocityX(PLAYER_ROLL_SPEED * this.rollDirection);
          }
        }
      }
      return;
    }

    const onFloor = this.body.blocked.down || this.body.touching.down;

    if (
      rightJustPressed &&
      onFloor &&
      isActionAvailable(this.currentMode, 'block')
    ) {
      this.startBlock();
      return;
    }

    if (
      Phaser.Input.Keyboard.JustDown(this.keyShift) &&
      isActionAvailable(this.currentMode, 'dash')
    ) {
      this.startDash();
      return;
    }
    if (Phaser.Input.Keyboard.JustDown(this.keyS) && onFloor) {
      this.startRoll();
      return;
    }

    let inputDirection: MoveDirection = 0;
    if (this.keyA.isDown && !this.keyD.isDown) inputDirection = -1;
    else if (this.keyD.isDown && !this.keyA.isDown) inputDirection = 1;

    if (inputDirection === 0) {
      this.setVelocityX(0);
    } else {
      this.setVelocityX(PLAYER_RUN_SPEED * inputDirection);
      // Gunslinger facing is driven by the cursor (see updateAimFacing); only
      // sword_master flips with movement direction.
      if (!this.isGunslingerMode()) {
        this.setFacing(inputDirection === -1);
      }
    }

    let wallContact: MoveDirection = 0;
    if (!onFloor) {
      const touchingLeft =
        this.body.blocked.left || this.body.touching.left;
      const touchingRight =
        this.body.blocked.right || this.body.touching.right;
      if (touchingLeft && this.keyA.isDown) wallContact = -1;
      else if (touchingRight && this.keyD.isDown) wallContact = 1;
    }

    if (
      wallContact !== 0 &&
      this.body.velocity.y <= 0 &&
      isActionAvailable(this.currentMode, 'ledge_climb')
    ) {
      const ledgeWall = this.findLedgeWall(wallContact);
      if (ledgeWall) {
        this.startClimb(ledgeWall);
        return;
      }
    }
    if (
      !onFloor &&
      this.body.velocity.y < 0 &&
      this.body.velocity.x !== 0 &&
      isActionAvailable(this.currentMode, 'ledge_climb')
    ) {
      const grazingDirection: MoveDirection =
        this.body.velocity.x > 0 ? 1 : -1;
      const grazing = this.findGrazingWall(grazingDirection);
      if (grazing) {
        this.startClimb(grazing);
        return;
      }
    }

    if (Phaser.Input.Keyboard.JustDown(this.keyW) && onFloor) {
      this.setVelocityY(PLAYER_JUMP_VELOCITY);
    }
    if (
      Phaser.Input.Keyboard.JustUp(this.keyW) &&
      this.body.velocity.y < 0
    ) {
      this.setVelocityY(this.body.velocity.y * JUMP_CUT_VELOCITY_MULTIPLIER);
    }

    this.wallSlideDirection =
      wallContact !== 0 && this.body.velocity.y > 0 ? wallContact : 0;
    if (
      this.wallSlideDirection !== 0 &&
      this.body.velocity.y > WALL_SLIDE_MAX_VY
    ) {
      this.setVelocityY(WALL_SLIDE_MAX_VY);
    }

    this.updateVisualState();
  }

  private isRollAttackInProgress(): boolean {
    // Roll-attack only exists in sword_master (regular and magic). Gunslinger
    // attack1 is its only attack, not a roll-cancel — so the slide-on-velocity
    // behavior must not apply there.
    return (
      this.currentMode === 'sword_master' &&
      this.attackCounter === ROLL_ATTACK_STEP
    );
  }

  private isGunslingerMode(): boolean {
    return (
      this.currentMode === 'gunslinger_gun1' ||
      this.currentMode === 'gunslinger_gun2'
    );
  }

  private tryAdvanceMode(direction: 1 | -1): void {
    // Gate switches to "free" states. Mid-action wheel input is silently
    // dropped so swaps never interrupt an attack/dash/roll/block/climb.
    if (this.lockedAction !== null) return;
    const currentIndex = MODE_ORDER.indexOf(this.currentMode);
    if (currentIndex < 0) return;
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= MODE_ORDER.length) return;
    // Capture floor contact + body.bottom BEFORE the new mode's anchor takes
    // effect. Modes have different frame heights (sword_master 37, gunslinger
    // 48) and different bodyOffsetY, so swapping leaves body.bottom several
    // pixels below the floor surface. We re-snap sprite.y after the swap so
    // body.bottom is preserved. Mid-air swaps deliberately skip the snap —
    // a vertical teleport would be more jarring than the natural body shift,
    // and physics will reconcile on the next ground contact.
    const wasOnFloor = this.body.blocked.down || this.body.touching.down;
    const prevBodyBottom = this.body.bottom;
    this.currentMode = MODE_ORDER[nextIndex];
    this.wheelCooldownUntil = this.scene.time.now + WHEEL_COOLDOWN_MS;
    // Magic stance is sword_master-only; clear it when switching away so we
    // don't snap back into magic if the player wheels back to sword_master.
    if (this.currentMode !== 'sword_master') {
      this.magicMode = false;
    }
    this.ensurePlayerGunForMode();
    this.applyModeChangeAnimation();
    if (wasOnFloor) {
      // Inverse of Phaser's body math:
      //   body.bottom = sprite.y - displayOriginY*scaleY + offset.y*scaleY + body.height
      // Solve for sprite.y so body.bottom = prevBodyBottom.
      const newY =
        prevBodyBottom +
        this.displayOriginY * this.scaleY -
        this.body.offset.y * this.scaleY -
        this.body.height;
      this.setPosition(this.x, newY);
    }
  }

  private applyModeChangeAnimation(): void {
    const logical = this.visualStateToLogical(this.currentVisualState);
    this.playLogical(logical);
  }

  private visualStateToLogical(
    state: PlayerVisualState,
  ): LogicalAnimationKey {
    switch (state) {
      case 'run':
        return 'run';
      case 'fall':
        return 'fall';
      case 'wall_slide':
        return 'wall_slide';
      case 'idle':
      case 'attack':
      case 'dash':
      case 'roll':
      case 'block':
      case 'climb':
      default:
        return 'idle';
    }
  }

  private playLogical(
    logical: LogicalAnimationKey,
    options: {
      ignoreIfPlaying?: boolean;
      repeat?: number;
      duration?: number;
    } = {},
  ): boolean {
    const key = animKey(this.currentMode, logical);
    if (!key) return false;
    const ignoreIfPlaying = options.ignoreIfPlaying ?? false;
    const hasOverrides =
      options.repeat !== undefined || options.duration !== undefined;
    if (hasOverrides) {
      const playArgs: Record<string, unknown> = { key };
      if (options.repeat !== undefined) playArgs.repeat = options.repeat;
      if (options.duration !== undefined) {
        playArgs.duration = options.duration;
        // Phaser's calculateDuration prefers frameRate when both are
        // non-null, and frameRate falls back to anim.frameRate (12) when
        // unset — silently ignoring our duration override. Passing
        // frameRate: null forces it to derive frameRate from duration.
        playArgs.frameRate = null;
      }
      this.play(
        playArgs as unknown as Phaser.Types.Animations.PlayAnimationConfig,
        ignoreIfPlaying,
      );
    } else {
      this.play(key, ignoreIfPlaying);
    }
    this.syncGunOverlayForBodyAnim(key, logical);
    return true;
  }

  private handleAttackInput(): void {
    if (this.lockedAction === 'attack') {
      if (
        this.isRollAttackInProgress() ||
        this.attackCounter === TELEPORT_ATTACK_STEP
      ) {
        return;
      }
      this.queuedAttack = true;
      return;
    }
    if (this.lockedAction === 'roll') {
      // Roll-attack is sword_master-only.
      if (this.currentMode !== 'sword_master') return;
      this.attackCounter = ROLL_ATTACK_STEP;
      this.currentAttackKind = this.magicMode ? 'magic' : 'regular';
      this.startAttackAnim(this.attackCounter);
      return;
    }
    if (this.lockedAction !== null) {
      return;
    }

    const onFloor = this.body.blocked.down || this.body.touching.down;
    // Sword-master attacks are ground-only. Gunslinger fires from anywhere
    // (idle, moving, jumping, falling).
    if (!onFloor && !this.isGunslingerMode()) {
      return;
    }

    if (this.keySpace.isDown) {
      // Teleport-attack is sword_master-only — gunslinger has no attack6.
      if (this.currentMode !== 'sword_master') return;
      this.attackCounter = TELEPORT_ATTACK_STEP;
      this.currentAttackKind = 'regular';
      this.startAttackAnim(this.attackCounter);
      return;
    }

    this.attackCounter = this.getFirstComboStep();
    this.currentAttackKind = this.magicMode ? 'magic' : 'regular';
    this.startAttackAnim(this.attackCounter);
  }

  private getFirstComboStep(): number {
    return this.currentMode === 'sword_master' ? COMBO_FIRST_STEP : 1;
  }

  private getMaxComboStep(): number {
    return this.currentMode === 'sword_master' ? MAX_COMBO_STEP : 1;
  }

  private startAttackAnim(step: number): void {
    this.lockedAction = 'attack';
    // Each new swing starts with a fresh set so a re-attack against the same
    // enemy lands again. This includes combo continuations (queuedAttack →
    // step+1) and chained roll/teleport attacks.
    this.swordHitTargets.clear();
    // Gunslinger firing animates the gun overlay only — the body keeps
    // tracking physics state (idle/run/fall) so the player can move and
    // jump while shooting. visualState is left alone so updateVisualState
    // continues to drive body anims; lockedAction='attack' is purely a
    // cooldown/trigger flag, not a freeze.
    if (this.isGunslingerMode()) {
      const config = this.projectileFireConfigs.get(
        this.currentMode as 'gunslinger_gun1' | 'gunslinger_gun2',
      );
      if (this.playerGun) {
        this.playerGun.playOverlay('attack1', config?.overlayDurationMs);
      }
      return;
    }

    this.currentVisualState = 'attack';
    // Roll-attack carries momentum from the roll. Other sword_master attacks
    // freeze the player in place.
    if (step !== ROLL_ATTACK_STEP) {
      this.setVelocityX(0);
    }
    if (this.currentAttackKind === 'magic') {
      this.play(magicAttackAnimKey(step));
      return;
    }
    const logical = `attack${step}` as LogicalAnimationKey;
    this.playLogical(logical);
  }

  private startDash(): void {
    const direction = this.resolveFacingDirection();
    this.lockedAction = 'dash';
    this.currentVisualState = 'dash';
    this.setFacing(direction === -1);
    this.setVelocityX(PLAYER_DASH_SPEED * direction);
    this.playLogical('dash', { duration: PLAYER_DASH_DURATION_MS });
  }

  private startRoll(): void {
    const direction = this.resolveFacingDirection();
    this.lockedAction = 'roll';
    this.currentVisualState = 'roll';
    this.setFacing(direction === -1);
    this.rollDirection = direction;
    // Gunslinger roll has a wind-up: lateral velocity is gated by frame in
    // updateInner so frames 0..1 stay in place. Sword_master rolls accelerate
    // immediately as before.
    if (this.isGunslingerMode()) {
      this.setVelocityX(0);
    } else {
      this.setVelocityX(PLAYER_ROLL_SPEED * direction);
    }
    this.playLogical('roll');
  }

  private startBlock(): void {
    this.lockedAction = 'block';
    this.currentVisualState = 'block';
    this.setVelocityX(0);
    this.playLogical('block', { repeat: 0 });
  }

  private findLedgeWall(wallDirection: MoveDirection): LedgeTrigger | null {
    const PROBE_WIDTH = 4;
    const PROBE_HEIGHT = 4;
    const probeX =
      wallDirection === 1
        ? this.body.right + 1
        : this.body.left - 1 - PROBE_WIDTH;
    const above = this.scene.physics.overlapRect(
      probeX,
      this.body.top - PROBE_HEIGHT - 4,
      PROBE_WIDTH,
      PROBE_HEIGHT,
      false,
      true,
    );
    if (above.length > 0) return null;
    const below = this.scene.physics.overlapRect(
      probeX,
      this.body.top + 2,
      PROBE_WIDTH,
      PROBE_HEIGHT,
      false,
      true,
    ) as ArcadeBody[];
    if (below.length === 0) return null;
    const wallBody = below[0];
    return {
      direction: wallDirection,
      wallTop: wallBody.top,
      wallEdgeX: wallDirection === 1 ? wallBody.left : wallBody.right,
    };
  }

  private findGrazingWall(direction: MoveDirection): LedgeTrigger | null {
    const dt = this.scene.game.loop.delta / 1000;
    const dx = this.body.velocity.x * dt;
    const dy = this.body.velocity.y * dt;
    const nextLeft = this.body.left + dx;
    const nextTop = this.body.top + dy;
    const overlaps = this.scene.physics.overlapRect(
      nextLeft,
      nextTop,
      PHYSICS_BODY_WIDTH,
      PHYSICS_BODY_HEIGHT,
      false,
      true,
    ) as ArcadeBody[];
    for (const wallBody of overlaps) {
      if (
        wallBody.top > nextTop &&
        wallBody.top < nextTop + PHYSICS_BODY_HEIGHT
      ) {
        return {
          direction,
          wallTop: wallBody.top,
          wallEdgeX: direction === 1 ? wallBody.left : wallBody.right,
        };
      }
    }
    return null;
  }

  private startClimb(trigger: LedgeTrigger): void {
    this.lockedAction = 'climb';
    this.currentVisualState = 'climb';
    this.setVelocityX(0);
    this.setVelocityY(0);
    this.body.setAllowGravity(false);
    this.setFacing(trigger.direction === -1);
    this.playLogical('ledge_climb');
    const targetBodyLeft =
      trigger.direction === 1
        ? trigger.wallEdgeX
        : trigger.wallEdgeX - PHYSICS_BODY_WIDTH;
    const targetBodyTop = trigger.wallTop - PHYSICS_BODY_HEIGHT;
    const newSpriteX = targetBodyLeft + PHYSICS_BODY_WIDTH / 2;
    // body.position.y = sprite.y - displayOriginY*scaleY + offset.y*scaleY,
    // so sprite.y = body.top + (displayOriginY - offset.y) * scaleY.
    const newSpriteY =
      targetBodyTop +
      (this.displayOriginY - this.body.offset.y) * this.scaleY;
    this.setPosition(newSpriteX, newSpriteY);
  }

  private resolveFacingDirection(): 1 | -1 {
    if (this.keyA.isDown && !this.keyD.isDown) return -1;
    if (this.keyD.isDown && !this.keyA.isDown) return 1;
    return this.flipX ? -1 : 1;
  }

  private updateVisualState(): void {
    // Gunslinger firing doesn't animate the body — it animates the gun
    // overlay only. So no early return is needed; the body keeps switching
    // between idle/run/fall normally even while the overlay plays attack1.
    const onFloor = this.body.blocked.down || this.body.touching.down;
    const vx = this.body.velocity.x;
    const vy = this.body.velocity.y;

    let next: 'idle' | 'run' | 'fall' | 'wall_slide';
    if (!onFloor) {
      next = this.wallSlideDirection !== 0 ? 'wall_slide' : 'fall';
    } else if (vx !== 0) {
      next = 'run';
    } else {
      next = 'idle';
    }

    if (next === this.currentVisualState && next !== 'fall') {
      return;
    }
    this.currentVisualState = next;

    switch (next) {
      case 'idle':
        this.playLogical('idle', { ignoreIfPlaying: true });
        break;
      case 'run':
        this.playLogical('run', { ignoreIfPlaying: true });
        break;
      case 'wall_slide':
        this.playLogical('wall_slide', { ignoreIfPlaying: true });
        break;
      case 'fall':
        this.playLogical('fall', { ignoreIfPlaying: true });
        if (vy < 0) {
          this.anims.pause();
          this.setFrame(0);
        } else {
          this.anims.resume();
        }
        break;
    }

  }

  private onAnimationComplete(animation: Phaser.Animations.Animation): void {
    const key = animation.key;
    if (ATTACK_KEYS.has(key)) {
      if (this.queuedAttack && this.attackCounter < this.getMaxComboStep()) {
        this.queuedAttack = false;
        this.attackCounter += 1;
        this.startAttackAnim(this.attackCounter);
        return;
      }
      this.endLockedAction();
      return;
    }

    if (DASH_KEYS.has(key) || ROLL_KEYS.has(key) || BLOCK_KEYS.has(key)) {
      this.endLockedAction();
      return;
    }

    if (TAKE_HIT_KEYS.has(key)) {
      if (this.lockedAction === 'hurt') {
        this.endLockedAction();
      }
      return;
    }

    if (DEATH_KEYS.has(key)) {
      // One-shot death; freeze the corpse so it doesn't keep sliding once it
      // settles. Locked action stays 'dead' until the scene restarts.
      this.setVelocity(0, 0);
      return;
    }

    if (LEDGE_CLIMB_KEYS.has(key)) {
      const targetBodyBottom = this.body.bottom;
      this.body.setAllowGravity(true);
      this.endLockedAction();
      const targetBodyTop = targetBodyBottom - PHYSICS_BODY_HEIGHT;
      // Same inverse-body math as startClimb — anchor in source pixels times
      // scaleY converts to world-space sprite Y for the new (post-climb) anim.
      const newSpriteY =
        targetBodyTop +
        (this.displayOriginY - this.body.offset.y) * this.scaleY;
      this.setPosition(this.x, newSpriteY);
    }
  }

  private onAnimationUpdate(
    animation: Phaser.Animations.Animation,
    frame: Phaser.Animations.AnimationFrame,
  ): void {
    if (animation.key === TELEPORT_ANIM_KEY) {
      if (this.teleportFired) return;
      if (frame.index < this.teleportAppearStartFrame) return;
      this.applyTeleport();
      this.teleportFired = true;
    }
  }

  // Overlay-driven projectile spawn. Body no longer plays attack1, so the
  // fire-frame trigger lives on the gun overlay's own animation update.
  private onGunOverlayUpdate(
    animation: Phaser.Animations.Animation,
    frame: Phaser.Animations.AnimationFrame,
  ): void {
    if (this.firedProjectile) return;
    if (this.lockedAction !== 'attack') return;
    if (!this.isGunslingerMode()) return;
    const config = this.projectileFireConfigs.get(
      this.currentMode as 'gunslinger_gun1' | 'gunslinger_gun2',
    );
    if (!config) return;
    if (animation.key !== config.overlayKey) return;
    if (frame.index < config.fireFrame) return;
    this.spawnProjectile(config);
    this.firedProjectile = true;
  }

  // Overlay-driven attack-end. With the body no longer playing attack1, the
  // gun overlay's attack1 completion is what closes the locked-attack window.
  private onGunOverlayComplete(
    animation: Phaser.Animations.Animation,
  ): void {
    if (this.lockedAction !== 'attack') return;
    if (!this.isGunslingerMode()) return;
    const config = this.projectileFireConfigs.get(
      this.currentMode as 'gunslinger_gun1' | 'gunslinger_gun2',
    );
    if (!config) return;
    if (animation.key !== config.overlayKey) return;
    this.endLockedAction();
  }

  private applyTeleport(): void {
    const direction = this.flipX ? -1 : 1;
    this.x += TELEPORT_DISTANCE_PX * direction;
  }

  private spawnProjectile(config: ProjectileFireConfig): void {
    // Aim is taken from the gun pivot (grip) → cursor. The barrel extends
    // along the gun's local +X, so rotating (PROJECTILE_BARREL_LENGTH_PX, 0)
    // by `angle` places the spawn at the visible muzzle for any firing
    // direction; the same `angle` drives the velocity vector.
    const pointer = this.scene.input.activePointer;
    const cursorX = pointer?.worldX ?? this.x;
    const cursorY = pointer?.worldY ?? this.y;
    const pivotSign = this.flipX ? -1 : 1;
    // Pivot is in source-pixel space relative to the body's frame center, so
    // it scales with sprite.scaleX/Y to land on the visible grip when the
    // body animation has a non-1 displayScale.
    const pivotX =
      this.x + GUN_OVERLAY_PIVOT_OFFSET_X * pivotSign * this.scaleX;
    const pivotY = this.y + GUN_OVERLAY_PIVOT_OFFSET_Y * this.scaleY;
    const angle = Math.atan2(cursorY - pivotY, cursorX - pivotX);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const spawnX = pivotX + PROJECTILE_BARREL_LENGTH_PX * cosA;
    const spawnY = pivotY + PROJECTILE_BARREL_LENGTH_PX * sinA;
    const spawner = this.scene as unknown as ProjectileSpawnerScene;
    spawner.spawnProjectile({
      x: spawnX,
      y: spawnY,
      mode: config.mode,
      velocityX: config.speed * cosA,
      velocityY: config.speed * sinA,
    });
  }

  // Per-frame overlap scan during a sword attack. Builds a forward rect
  // and applies SWORD_ATTACK_DAMAGE to each Enemy whose body overlaps. The
  // per-attack `swordHitTargets` set guarantees each enemy takes at most one
  // hit per swing even though this runs every frame the attack is locked.
  // Called only for sword_master mode; gunslinger damage flows through the
  // projectile → enemy overlap registered on the GameScene.
  private applySwordHits(): void {
    if (this.lockedAction !== 'attack') return;
    if (this.isGunslingerMode()) return;
    const facing: 1 | -1 = this.flipX ? -1 : 1;
    const hitboxX =
      facing === 1 ? this.x : this.x - SWORD_ATTACK_REACH_X;
    const hitboxY = this.y - SWORD_ATTACK_REACH_Y / 2;
    // Phaser's overlapRect returns Arcade Bodies (dynamic+static depending
    // on flags). Dynamic-only is what we want — enemies have dynamic bodies;
    // the tilemap collision layer is static and irrelevant here.
    const hits = this.scene.physics.overlapRect(
      hitboxX,
      hitboxY,
      SWORD_ATTACK_REACH_X,
      SWORD_ATTACK_REACH_Y,
      true,
      false,
    ) as Phaser.Physics.Arcade.Body[];
    for (const body of hits) {
      const obj = body.gameObject;
      if (!(obj instanceof Enemy)) continue;
      if (obj.isDead()) continue;
      if (this.swordHitTargets.has(obj)) continue;
      obj.takeDamage(SWORD_ATTACK_DAMAGE, this.x, this.y);
      this.swordHitTargets.add(obj);
    }
  }

  getHealth(): number {
    return this.health;
  }

  getMaxHealth(): number {
    return PLAYER_MAX_HEALTH;
  }

  isDead(): boolean {
    return this.lockedAction === 'dead';
  }

  hurt(damage: number, sourceX: number, _sourceY: number): void {
    if (this.lockedAction === 'dead') return;
    if (this.scene.time.now < this.invulnerableUntil) return;

    // Block negates damage from the front only — souls-like discipline.
    // facing = +1 when looking right (flipX false), -1 when looking left.
    // A source on the same side as facing means the player is looking at it,
    // so the swing/shot lands on the raised shield. Back-attacks still hurt
    // so block isn't omnipotent.
    if (this.lockedAction === 'block') {
      const facing: 1 | -1 = this.flipX ? -1 : 1;
      const sourceDirection: 1 | -1 = sourceX >= this.x ? 1 : -1;
      if (facing === sourceDirection) {
        // Still grant a short invuln window so a single attack can't burn
        // through block by re-firing within the same swing.
        this.invulnerableUntil = this.scene.time.now + PLAYER_INVULN_MS;
        return;
      }
    }

    this.health = Math.max(0, this.health - damage);

    const knockbackDir: 1 | -1 = this.x >= sourceX ? 1 : -1;
    this.setVelocityX(PLAYER_HURT_KNOCKBACK_X * knockbackDir);
    this.setVelocityY(PLAYER_HURT_KNOCKBACK_Y);
    this.invulnerableUntil = this.scene.time.now + PLAYER_INVULN_MS;

    if (this.health <= 0) {
      this.enterDeadState();
      return;
    }

    this.cancelTransientState();
    this.lockedAction = 'hurt';
    this.currentVisualState = 'idle';
    this.playLogical('take_hit');
  }

  private enterDeadState(): void {
    this.cancelTransientState();
    this.lockedAction = 'dead';
    this.currentVisualState = 'idle';
    this.playLogical('death');
    this.emit(PLAYER_DIED_EVENT);
  }

  // Clears in-flight action flags so a previous attack/dash/roll/block/climb
  // doesn't leak side effects after hurt/death interrupts it. Restores gravity
  // (climb disables it) and re-shows the gun overlay since the body anim is
  // about to change.
  private cancelTransientState(): void {
    this.queuedAttack = false;
    this.attackCounter = 0;
    this.teleportFired = false;
    this.firedProjectile = false;
    this.body.setAllowGravity(true);
  }

  private endLockedAction(): void {
    const wasGunslingerAttack =
      this.lockedAction === 'attack' && this.isGunslingerMode();
    this.lockedAction = null;
    this.queuedAttack = false;
    this.attackCounter = 0;
    this.teleportFired = false;
    this.firedProjectile = false;
    // Gunslinger firing doesn't change the body's visual state, so closing
    // the locked-attack window must NOT snap the body back to idle — the
    // body is already showing the correct run/jump/fall/idle pose driven
    // by updateVisualState(). Just clear the flags and re-arm the overlay
    // back to idle (the gun's attack1 is one-shot and would otherwise sit
    // on its last frame until the next body anim change).
    if (wasGunslingerAttack) {
      this.playerGun?.playOverlay('idle');
      return;
    }
    this.currentVisualState = 'idle';
    this.playLogical('idle', { ignoreIfPlaying: true });
  }

  private applyAnimationAnchor(animation: Phaser.Animations.Animation): void {
    const {
      originX,
      originY,
      bodySourceWidth,
      bodySourceHeight,
      bodyOffsetX,
      bodyOffsetY,
      displayScale,
    } = getSpriteAnchor(
      animation.key,
      PHYSICS_BODY_WIDTH,
      PHYSICS_BODY_HEIGHT,
      this.flipX,
    );
    this.setOrigin(originX, originY);
    this.setScale(displayScale);
    // Body source size is divided by scale so that Phaser's auto-scaling
    // (body.width = sourceWidth * scale) lands on PHYSICS_BODY size in world.
    this.body.setSize(bodySourceWidth, bodySourceHeight);
    this.body.setOffset(bodyOffsetX, bodyOffsetY);
  }

  // Debug fly mode: enables free WASD movement across the world so the camera
  // can pan over every LDtk level. Disables gravity and tile collision so gaps
  // between scattered levels don't trap the player. All in-progress locked
  // actions (attack/dash/roll/block/climb) are cleared so re-entering normal
  // mode starts clean. Mode swaps via wheel still work in fly mode.
  private toggleFlyMode(): void {
    this.flyMode = !this.flyMode;
    if (this.flyMode) {
      this.body.setAllowGravity(false);
      this.body.checkCollision.none = true;
      this.lockedAction = null;
      this.queuedAttack = false;
      this.attackCounter = 0;
      this.teleportFired = false;
      this.firedProjectile = false;
      this.wallSlideDirection = 0;
      this.setVelocity(0, 0);
      this.currentVisualState = 'idle';
      this.playLogical('idle', { ignoreIfPlaying: true });
    } else {
      this.body.setAllowGravity(true);
      this.body.checkCollision.none = false;
      this.setVelocity(0, 0);
      this.currentVisualState = 'idle';
      this.playLogical('idle', { ignoreIfPlaying: true });
    }
  }

  private updateFlyMode(): void {
    let vx = 0;
    let vy = 0;
    if (this.keyA.isDown && !this.keyD.isDown) vx = -FLY_SPEED;
    else if (this.keyD.isDown && !this.keyA.isDown) vx = FLY_SPEED;
    if (this.keyW.isDown && !this.keyS.isDown) vy = -FLY_SPEED;
    else if (this.keyS.isDown && !this.keyW.isDown) vy = FLY_SPEED;
    this.setVelocity(vx, vy);
    if (vx < 0) this.setFacing(true);
    else if (vx > 0) this.setFacing(false);
    const moving = vx !== 0 || vy !== 0;
    const nextState: PlayerVisualState = moving ? 'run' : 'idle';
    if (nextState !== this.currentVisualState) {
      this.currentVisualState = nextState;
      this.playLogical(moving ? 'run' : 'idle', { ignoreIfPlaying: true });
    }
  }

  setFacing(faceLeft: boolean): void {
    if (this.flipX === faceLeft) return;
    this.setFlipX(faceLeft);
    const currentAnim = this.anims.currentAnim;
    if (currentAnim) {
      this.applyAnimationAnchor(currentAnim);
    }
  }

  // Body faces toward the cursor in gunslinger modes so the gun overlay's
  // 360° aim never disagrees with the body's left/right flip. Runs even
  // while standing still — the player turns to track the mouse.
  private updateAimFacing(): void {
    if (!this.isGunslingerMode()) return;
    const pointer = this.scene.input.activePointer;
    if (!pointer) return;
    this.setFacing(pointer.worldX < this.x);
  }

  // Creates the PlayerGun on entry to a gunslinger mode, swaps its art on a
  // gun1 ↔ gun2 transition, and destroys it on exit to sword_master. Idempotent.
  private ensurePlayerGunForMode(): void {
    if (
      this.currentMode === 'gunslinger_gun1' ||
      this.currentMode === 'gunslinger_gun2'
    ) {
      if (this.playerGun) {
        this.playerGun.setMode(this.currentMode);
      } else {
        this.playerGun = new PlayerGun(
          this.scene,
          this.x,
          this.y,
          this.currentMode,
        );
        // Body no longer plays attack1, so projectile spawn timing and
        // attack-end signaling come from the gun overlay's own animation
        // events. Listeners are torn down automatically when the sprite is
        // destroyed in destroyPlayerGun().
        this.playerGun.on(
          Phaser.Animations.Events.ANIMATION_UPDATE,
          this.onGunOverlayUpdate,
          this,
        );
        this.playerGun.on(
          Phaser.Animations.Events.ANIMATION_COMPLETE,
          this.onGunOverlayComplete,
          this,
        );
      }
    } else {
      this.destroyPlayerGun();
    }
  }

  private destroyPlayerGun(): void {
    if (!this.playerGun) return;
    this.playerGun.destroy();
    this.playerGun = null;
  }

  // Toggles overlay visibility based on the registry the body anim came from
  // (gun visible only when the body is rendering no_gun art). The overlay's
  // attack/idle choice is driven independently — startAttackAnim triggers
  // attack1, and the overlay-anim-complete handler returns to idle. Calling
  // playOverlay('idle') here mid-fire would clobber the in-progress attack
  // (the body switches between idle/run/fall during a shot), so the idle
  // re-arm is gated on lockedAction != 'attack'.
  private syncGunOverlayForBodyAnim(
    bodyAnimKey: string,
    _logical: LogicalAnimationKey,
  ): void {
    if (!this.playerGun) return;
    const source = getAnimationSourceMode(bodyAnimKey);
    if (source === 'gunslinger_body') {
      this.playerGun.setVisible(true);
      if (this.lockedAction !== 'attack') {
        this.playerGun.playOverlay('idle');
      }
    } else {
      this.playerGun.setVisible(false);
    }
  }

  // Each-frame pose update: gun grip snaps to the player's hand pivot and
  // rotates to face the cursor. Skipped when there's no active overlay so
  // sword_master frames don't pay for the math.
  private syncPlayerGun(): void {
    if (!this.playerGun) return;
    const pointer = this.scene.input.activePointer;
    const cursorX = pointer?.worldX ?? this.x;
    const cursorY = pointer?.worldY ?? this.y;
    this.playerGun.syncToOwner(
      this.x,
      this.y,
      this.flipX,
      this.scaleX,
      cursorX,
      cursorY,
    );
  }
}
