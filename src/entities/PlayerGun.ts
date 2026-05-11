import Phaser from 'phaser';
import {
  ENTITY_DEPTH,
  GUN_OVERLAY_GRIP_ORIGIN_X,
  GUN_OVERLAY_PIVOT_OFFSET_X,
  GUN_OVERLAY_PIVOT_OFFSET_Y,
} from '../constants';
import {
  type GunslingerProjectileMode,
  gunOverlayAnimKey,
  getSpriteAnchor,
} from '../sprites/characterLoader';

// Gun overlay sprite layered on top of the player body during gunslinger
// modes. Holds no physics body — purely visual. Position and rotation are
// driven by the owning Player each frame; visibility is toggled based on
// whether the body's currently-playing animation came from the no_gun
// registry (gun visible) or the baked-gun registry (gun hidden).
export class PlayerGun extends Phaser.GameObjects.Sprite {
  private gunMode: GunslingerProjectileMode;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    mode: GunslingerProjectileMode,
  ) {
    const idleKey = gunOverlayAnimKey(mode, 'idle');
    if (!scene.textures.exists(idleKey)) {
      throw new Error(
        `Gun overlay texture missing: "${idleKey}". ` +
          'Did PreloadScene register all character animations?',
      );
    }
    super(scene, x, y, idleKey);
    this.gunMode = mode;

    scene.add.existing(this);
    // Pivot is the grip of the gun, not its center, so rotation looks correct
    // when tracking the cursor. The grip pixel sits at frame x≈3 within the
    // 32px overlay; using GUN_OVERLAY_GRIP_ORIGIN_X aligns the rotation pivot
    // with the visible grip instead of the empty left edge.
    this.setOrigin(GUN_OVERLAY_GRIP_ORIGIN_X, 0.5);
    // One above the player so the gun renders on top of the body sprite.
    this.setDepth(ENTITY_DEPTH + 1);
    this.on(
      Phaser.Animations.Events.ANIMATION_START,
      this.applyOverlayScale,
      this,
    );
    this.play(idleKey);
  }

  private applyOverlayScale(animation: Phaser.Animations.Animation): void {
    // Gun overlay has no physics body — only the visual scale matters. Body
    // dims passed to getSpriteAnchor are unused for scale, so 0/0 is fine.
    const { displayScale } = getSpriteAnchor(animation.key, 0, 0);
    this.setScale(displayScale);
  }

  getMode(): GunslingerProjectileMode {
    return this.gunMode;
  }

  // Swap to a different gun (e.g. wheeling from gun1 → gun2). Replays the
  // current animation kind on the new spritesheet so visual continuity is
  // preserved across the swap.
  setMode(mode: GunslingerProjectileMode): void {
    if (mode === this.gunMode) return;
    this.gunMode = mode;
    const currentKey = this.anims.currentAnim?.key;
    const wasFiring =
      currentKey === gunOverlayAnimKey(
        mode === 'gunslinger_gun1' ? 'gunslinger_gun2' : 'gunslinger_gun1',
        'attack1',
      );
    this.playOverlay(wasFiring ? 'attack1' : 'idle');
  }

  playOverlay(kind: 'idle' | 'attack1', durationMs?: number): void {
    const key = gunOverlayAnimKey(this.gunMode, kind);
    // Phaser re-starts the anim if `ignoreIfPlaying` is false; pass true for
    // idle so we don't re-trigger the idle loop every frame the body changes
    // state. Attack1 is one-shot — always restart it explicitly.
    if (durationMs !== undefined) {
      // frameRate: null forces Phaser to honor `duration` — without it,
      // calculateDuration falls back to the anim's stored frameRate and
      // silently drops the duration override. The cast is required because
      // Phaser's PlayAnimationConfig types frameRate as `number | undefined`
      // but the runtime explicitly checks for null to disable the fallback.
      const playArgs = {
        key,
        duration: durationMs,
        frameRate: null,
      } as unknown as Phaser.Types.Animations.PlayAnimationConfig;
      this.play(playArgs, kind === 'idle');
    } else {
      this.play(key, kind === 'idle');
    }
  }

  // Snap to the player's grip position and rotate to point at the cursor.
  // ownerFlipX mirrors the pivot offset so the gun stays at the player's
  // hand regardless of facing. ownerScale scales the source-pixel pivot so
  // the grip alignment survives any displayScale on the body animation.
  syncToOwner(
    ownerX: number,
    ownerY: number,
    ownerFlipX: boolean,
    ownerScale: number,
    cursorWorldX: number,
    cursorWorldY: number,
  ): void {
    const pivotSign = ownerFlipX ? -1 : 1;
    const pivotX = ownerX + GUN_OVERLAY_PIVOT_OFFSET_X * pivotSign * ownerScale;
    const pivotY = ownerY + GUN_OVERLAY_PIVOT_OFFSET_Y * ownerScale;
    this.setPosition(pivotX, pivotY);

    const dx = cursorWorldX - pivotX;
    const dy = cursorWorldY - pivotY;
    const angle = Math.atan2(dy, dx);
    // When the cursor is on the left half (|angle| > 90°), rotating the
    // sprite alone would render the gun upside-down (barrel up, trigger
    // down). Mirror vertically in that case so the trigger always points
    // toward the ground regardless of aim direction.
    const flipY = Math.abs(angle) > Math.PI / 2;
    this.setFlipY(flipY);
    this.setRotation(angle);
  }
}
