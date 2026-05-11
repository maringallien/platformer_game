export type AnimationCategory =
  | 'movement'
  | 'attack'
  | 'state'
  | 'traversal'
  | 'ranged';

export interface FrameData {
  sheetWidth: number;
  sheetHeight: number;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  anchorX?: number;
  // Frame row (1-based pixel from top of frame) where the body's bottom
  // edge should sit. Defaults to frameHeight (body bottom = frame bottom).
  anchorY?: number;
  // Visual-only scale applied to the rendered sprite. Default 1.
  // Anchors stay in source-pixel terms; the renderer rescales the physics
  // body's source size so the world-space hitbox stays at PHYSICS_BODY size
  // regardless of displayScale.
  displayScale?: number;
  startFrame?: number;
  ambiguous?: boolean;
}

export interface AnimationStage {
  startFrame: number;
  endFrame: number;
}

export interface SimpleAnimation {
  type: 'simple';
  key: string;
  file: string;
  category: AnimationCategory;
  loops: boolean;
  frames: FrameData;
  originalName: string;
  stages?: Record<string, AnimationStage>;
}

export interface CharacterModeRegistry {
  type: 'standard';
  id: string;
  path: string;
  mode?: string;
  animations: Record<string, SimpleAnimation>;
}

// Wheel-cycled character modes. sword_master_magic is intentionally NOT here
// — it's a sub-stance of sword_master selected via F, not a wheel stop.
export type CharacterModeId =
  | 'sword_master'
  | 'gunslinger_gun1'
  | 'gunslinger_gun2';

// Non-wheel registries used as `sourceMode` targets when one mode borrows
// another's spritesheet, plus the gun-overlay registries rendered on top of
// the body via PlayerGun. None are selectable by the player and none belong
// in MODE_ORDER. They live alongside CharacterModeId so the registry pipeline
// (preload, register, key resolution) treats them uniformly.
export type OverlayModeId =
  | 'gunslinger_body'
  | 'gun1_overlay'
  | 'gun2_overlay';

// Any mode id that can appear as a `sourceMode` on a ResolvedAnimation.
export type AnyModeId = CharacterModeId | OverlayModeId;

// Cross-mode action vocabulary. Player.ts speaks in these abstract keys; the
// resolver decides which concrete registry key (and frame) each mode plays.
export type LogicalAnimationKey =
  | 'idle'
  | 'run'
  | 'fall'
  | 'wall_slide'
  | 'attack1'
  | 'attack2'
  | 'attack3'
  | 'attack4'
  | 'attack5'
  | 'attack6'
  | 'dash'
  | 'roll'
  | 'block'
  | 'ledge_climb'
  | 'jump'
  | 'death'
  | 'take_hit';

export interface ResolvedAnimation {
  registryKey: string;
  // When set, resolves the animation against this mode's spritesheet instead
  // of the calling mode. Used when one character mode borrows another's
  // animation (e.g. gunslinger has no dash art and reuses sword_master's),
  // or routes to a shared overlay registry like 'gunslinger_body'.
  sourceMode?: AnyModeId;
}
