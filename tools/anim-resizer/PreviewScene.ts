import Phaser from 'phaser';
import {
  DEFAULT_CHARACTER_FPS,
  gunOverlayAnimKey,
  preloadAllCharacters,
  preloadAllEntities,
  registerAllCharacterAnimations,
  registerAllEntityAnimations,
  type AnimationListing,
} from '../../src/sprites/characterLoader';
import {
  GUN_OVERLAY_GRIP_ORIGIN_X,
  GUN_OVERLAY_PIVOT_OFFSET_X,
  GUN_OVERLAY_PIVOT_OFFSET_Y,
} from '../../src/constants';
import {
  resolveValues,
  type AnimationEdit,
  type ResizerState,
} from './state';

const PHYSICS_BODY_WIDTH = 16;
const PHYSICS_BODY_HEIGHT = 24;

const BODY_BOX_COLOR = 0xff3355;
const ANCHOR_HANDLE_SIZE = 8;
const ANCHOR_HANDLE_COLOR = 0x66ff99;

// World origin = (0,0) is the sprite's logical center. The camera is
// centered there and zoomed; the canvas drawable region just shows the
// area around the origin.
const SPRITE_CENTER_X = 0;
const SPRITE_CENTER_Y = 0;

const COMPOSITE_BODY_MODE = 'gunslinger_body';
const COMPOSITE_GUN_MODE: 'gunslinger_gun1' | 'gunslinger_gun2' =
  'gunslinger_gun1';

export interface PreviewSceneCallbacks {
  readonly onAnchorDrag: (fullKey: string, patch: AnimationEdit) => void;
}

export interface PreviewSceneOptions {
  readonly callbacks: PreviewSceneCallbacks;
  readonly width: number;
  readonly height: number;
  readonly initialZoom: number;
  readonly onReady?: () => void;
}

export class PreviewScene extends Phaser.Scene {
  private readonly callbacks: PreviewSceneCallbacks;
  private readonly initialZoom: number;
  private readonly onReady?: () => void;

  private currentListing: AnimationListing | null = null;
  private currentState: ResizerState | null = null;

  private sprite: Phaser.GameObjects.Sprite | null = null;
  private gunOverlay: Phaser.GameObjects.Sprite | null = null;
  private bodyBox: Phaser.GameObjects.Graphics | null = null;
  private anchorHandle: Phaser.GameObjects.Rectangle | null = null;
  private gridGraphics: Phaser.GameObjects.Graphics | null = null;
  private listingByKey: Map<string, AnimationListing> = new Map();

  constructor(opts: PreviewSceneOptions) {
    super('PreviewScene');
    this.callbacks = opts.callbacks;
    this.initialZoom = opts.initialZoom;
    this.onReady = opts.onReady;
  }

  preload(): void {
    preloadAllCharacters(this);
    preloadAllEntities(this);
  }

  create(): void {
    registerAllCharacterAnimations(this, { defaultFps: DEFAULT_CHARACTER_FPS });
    registerAllEntityAnimations(this, { defaultFps: DEFAULT_CHARACTER_FPS });
    this.cameras.main.setBackgroundColor('#1e1e1e');
    this.cameras.main.centerOn(SPRITE_CENTER_X, SPRITE_CENTER_Y);
    this.cameras.main.setZoom(this.initialZoom);

    this.gridGraphics = this.add.graphics();
    this.gridGraphics.setDepth(0);
    this.drawCheckerboard();

    this.bodyBox = this.add.graphics();
    this.bodyBox.setDepth(4);

    const handle = this.add
      .rectangle(
        0,
        0,
        ANCHOR_HANDLE_SIZE,
        ANCHOR_HANDLE_SIZE,
        ANCHOR_HANDLE_COLOR,
        0.7,
      )
      .setStrokeStyle(1, 0x000000, 0.9)
      .setInteractive({ draggable: true, cursor: 'grab' });
    this.input.setDraggable(handle);
    handle.setDepth(5);
    handle.setVisible(false);
    this.anchorHandle = handle;

    this.input.on(Phaser.Input.Events.DRAG, this.onDrag, this);
    this.onReady?.();
  }

  setListings(listings: ReadonlyArray<AnimationListing>): void {
    this.listingByKey = new Map(listings.map((l) => [l.fullKey, l]));
  }

  setZoom(zoom: number): void {
    this.cameras.main.setZoom(zoom);
    this.cameras.main.centerOn(SPRITE_CENTER_X, SPRITE_CENTER_Y);
    this.drawCheckerboard();
  }

  applyState(state: ResizerState): void {
    this.currentState = state;
    const fullKey = state.selectedKey;
    if (!fullKey) {
      this.currentListing = null;
      this.disposeSprite();
      this.bodyBox?.clear();
      this.anchorHandle?.setVisible(false);
      return;
    }
    const listing = this.listingByKey.get(fullKey) ?? null;
    if (!listing) return;

    if (this.currentListing?.fullKey !== fullKey) {
      this.swapListing(listing);
    }
    this.applyValuesForCurrent(state.edits.get(fullKey));
  }

  private swapListing(listing: AnimationListing): void {
    this.disposeSprite();
    this.currentListing = listing;
    const sprite = this.add.sprite(SPRITE_CENTER_X, SPRITE_CENTER_Y, listing.fullKey);
    sprite.setOrigin(0.5, 0.5);
    sprite.setDepth(2);
    // Force-loop in the preview regardless of the registry's `loops` flag —
    // attacks/death/roll/etc. are one-shots in-game but should animate
    // continuously here so the user can size them across every frame.
    sprite.play({ key: listing.fullKey, repeat: -1 });
    this.sprite = sprite;

    if (listing.mode === COMPOSITE_BODY_MODE) {
      const gunKey = gunOverlayAnimKey(COMPOSITE_GUN_MODE, 'idle');
      if (this.textures.exists(gunKey)) {
        const gun = this.add.sprite(SPRITE_CENTER_X, SPRITE_CENTER_Y, gunKey);
        gun.setOrigin(GUN_OVERLAY_GRIP_ORIGIN_X, 0.5);
        gun.setDepth(3);
        gun.play({ key: gunKey, repeat: -1 });
        this.gunOverlay = gun;
      }
    }
  }

  private disposeSprite(): void {
    this.sprite?.destroy();
    this.sprite = null;
    this.gunOverlay?.destroy();
    this.gunOverlay = null;
  }

  private applyValuesForCurrent(edit: AnimationEdit | undefined): void {
    const listing = this.currentListing;
    const sprite = this.sprite;
    const bodyBox = this.bodyBox;
    const handle = this.anchorHandle;
    if (!listing || !sprite || !bodyBox || !handle) return;

    const { frameWidth, frameHeight } = listing.anim.frames;
    const resolved = resolveValues(listing, edit);
    const { displayScale, anchorX, anchorY } = resolved;

    sprite.setScale(displayScale);

    const anchorWorldX =
      SPRITE_CENTER_X + (anchorX - frameWidth / 2) * displayScale;
    const anchorWorldY =
      SPRITE_CENTER_Y + (anchorY - frameHeight / 2) * displayScale;

    bodyBox.clear();
    bodyBox.lineStyle(1, BODY_BOX_COLOR, 1);
    bodyBox.strokeRect(
      anchorWorldX - PHYSICS_BODY_WIDTH / 2,
      anchorWorldY - PHYSICS_BODY_HEIGHT,
      PHYSICS_BODY_WIDTH,
      PHYSICS_BODY_HEIGHT,
    );

    if (this.gunOverlay) {
      this.gunOverlay.setPosition(
        SPRITE_CENTER_X + GUN_OVERLAY_PIVOT_OFFSET_X * displayScale,
        SPRITE_CENTER_Y + GUN_OVERLAY_PIVOT_OFFSET_Y * displayScale,
      );
    }

    handle.setPosition(anchorWorldX, anchorWorldY);
    handle.setVisible(true);
  }

  private onDrag(
    _pointer: Phaser.Input.Pointer,
    gameObject: Phaser.GameObjects.GameObject,
    dragX: number,
    dragY: number,
  ): void {
    if (gameObject !== this.anchorHandle) return;
    const state = this.currentState;
    const listing = this.currentListing;
    if (!state || !listing || !state.selectedKey) return;
    const edit = state.edits.get(state.selectedKey);
    const resolved = resolveValues(listing, edit);
    if (resolved.displayScale <= 0) return;
    const { frameWidth, frameHeight } = listing.anim.frames;
    // Inverse of the anchor-world formula. dragX/Y are world coords because
    // Phaser drag events fire in world space (camera zoom doesn't affect them).
    const newAnchorX = Math.round(
      (dragX - SPRITE_CENTER_X) / resolved.displayScale + frameWidth / 2,
    );
    const newAnchorY = Math.round(
      (dragY - SPRITE_CENTER_Y) / resolved.displayScale + frameHeight / 2,
    );
    const clampedX = Math.max(0, Math.min(frameWidth, newAnchorX));
    const clampedY = Math.max(0, Math.min(frameHeight, newAnchorY));
    this.callbacks.onAnchorDrag(state.selectedKey, {
      anchorX: clampedX,
      anchorY: clampedY,
    });
  }

  // Light dotted grid centered on the sprite origin so the user can eyeball
  // pixel coordinates relative to (0,0) regardless of zoom.
  private drawCheckerboard(): void {
    const g = this.gridGraphics;
    if (!g) return;
    g.clear();
    g.fillStyle(0x252525, 1);
    g.fillRect(-200, -200, 400, 400);
    g.lineStyle(1, 0x333333, 1);
    for (let x = -200; x <= 200; x += 8) {
      g.lineBetween(x, -200, x, 200);
    }
    for (let y = -200; y <= 200; y += 8) {
      g.lineBetween(-200, y, 200, y);
    }
    // Origin crosshair.
    g.lineStyle(1, 0x555555, 1);
    g.lineBetween(-200, 0, 200, 0);
    g.lineBetween(0, -200, 0, 200);
  }
}
