export const GRAVITY_Y = 800;

// Camera zoom multiplier in GameScene. Higher = more zoomed-in on the player.
// Pixel-art sprites are small (sword_master frame is 90x37); zoom 3 keeps the
// character readable across typical desktop window sizes.
export const CAMERA_ZOOM = 3;

// Vertical follow offset in world units. Phaser subtracts this from the
// target's position when computing scroll, so a positive value pulls the
// camera up and the player renders below screen center. 36 ≈ one character
// length (sword_master frame is 37 px tall) — the player sits roughly one
// body below the vertical midpoint, leaving most of the viewport as headroom.
export const CAMERA_VERTICAL_OFFSET_PX = 36;

// Maximum world-pixel distance the camera is allowed to drift from its
// follow-offset target. The slow lerp (0.08) feels buttery on jumps but
// can't keep up with terminal-velocity falls — at ~15 px/frame the steady
// lag would push the player off screen. Per-frame clamp to this radius
// guarantees the player stays visible regardless of fall speed.
export const CAMERA_MAX_VERTICAL_LAG_PX = 50;

export const PLAYER_RUN_SPEED = 120;
export const PLAYER_JUMP_VELOCITY = -330;
// Jump-cut: releasing W while still rising scales the upward velocity.
// Smaller = snappier short-hop. Lower than 1 to actually cut the jump.
export const JUMP_CUT_VELOCITY_MULTIPLIER = 0.4;
// Extra gravity (additive to GRAVITY_Y) applied while the player is falling.
// Zero = symmetric rise/fall acceleration; a positive value makes the descent
// snappier than the ascent.
export const FALL_BONUS_GRAVITY = 0;
// Terminal fall speed. Arcade Physics is discrete: a body that moves more
// than one tile (16 px) per physics step can skip past floor colliders. At
// 60 FPS that's 16 * 60 = 960 px/s; 900 leaves a small margin.
export const PLAYER_MAX_FALL_SPEED = 900;
export const PLAYER_DASH_SPEED = 220;
export const PLAYER_DASH_DURATION_MS = 200;
export const PLAYER_ROLL_SPEED = 224;
// Wall slide: max downward velocity while sliding against a wall in air.
export const WALL_SLIDE_MAX_VY = 90;
// Mouse-wheel cooldown between character mode swaps. Suppresses trackpad
// spam (a single swipe can fire many wheel events) without feeling laggy.
export const WHEEL_COOLDOWN_MS = 150;

// Projectile tuning. Speed is per-mode because gun1 fires a small bullet
// while gun2 charges and lobs a larger energy shot.
export const PROJECTILE_GUN1_SPEED = 600;
export const PROJECTILE_GUN2_SPEED = 480;
// Lifetime ceiling so projectiles can't accumulate if they slip past world
// bounds or never collide with anything.
export const PROJECTILE_MAX_LIFETIME_MS = 2500;
// Distance from gun pivot (grip) to muzzle along the barrel axis. The barrel
// extends along the gun's local +X, so this offset rotates with the aim angle
// to place the projectile spawn at the visible muzzle for any firing
// direction. Derived from the gun's grip-to-muzzle pixel distance in the
// 32px overlay sprite (grip at frame x≈3, muzzle at frame x≈21 + the gun
// pivot's −2px shift relative to player center → ~24).
export const PROJECTILE_BARREL_LENGTH_PX = 24;
// Fire-rate multiplier applied to gun1's attack animation. >1 = faster: the
// body and overlay anims both have their playback duration divided by this,
// shortening the locked-attack window proportionally and increasing the rate
// at which the player can re-fire.
export const GUNSLINGER_GUN1_FIRE_RATE_MULTIPLIER = 1.3;

// Damage dealt by a player projectile (both gun1 and gun2 use the same value
// for now; per-mode damage can split out later if balance demands it).
export const PLAYER_PROJECTILE_DAMAGE = 10;
// Sword melee damage per swing. Melee is close-range, so the per-hit value
// is higher than a single projectile to compensate for the increased risk.
export const SWORD_ATTACK_DAMAGE = 15;
// Forward reach of the sword hitbox in source pixels (player frame is 90x37
// with a 16px-wide physics body, so 40px forward covers a generous swing).
export const SWORD_ATTACK_REACH_X = 40;
// Hitbox vertical extent in source pixels, centered on the player. Covers
// the full body height plus a bit to catch slightly above/below enemies.
export const SWORD_ATTACK_REACH_Y = 30;

// Player health and hurt-state tuning.
export const PLAYER_MAX_HEALTH = 100;
// Delay before the scene restarts after PLAYER_DIED_EVENT. Long enough for
// the death animation to play to completion (sword_master death is the
// longest at ~10 frames @ 12 fps ≈ 830ms) plus a brief beat so the corpse
// lingers before the world resets.
export const RESPAWN_DELAY_MS = 1500;
// Invulnerability window after taking a hit, in ms. Long enough to prevent
// multi-hit stunlock from a single enemy attack frame but short enough that
// the player can be punished by repeated attacks.
export const PLAYER_INVULN_MS = 700;
// Knockback velocity applied on hurt. X is scaled by direction (away from
// the source); Y is always negative (upward pop) for a satisfying feel.
export const PLAYER_HURT_KNOCKBACK_X = 180;
export const PLAYER_HURT_KNOCKBACK_Y = -180;

// Gun overlay pivot offset relative to the player's sprite center (player
// origin is 0.5,0.5 on a 48x48 frame). Positive X is forward (the sprite's
// flipX is mirrored automatically in PlayerGun); positive Y is down. Tuned to
// the no_gun idle hand pixel: bbox of the body sprite is x=17..29, y=21..47,
// hand at frame (28, 33) ≈ sprite center (24,24) + (+4, +9).
export const GUN_OVERLAY_PIVOT_OFFSET_X = -2;
export const GUN_OVERLAY_PIVOT_OFFSET_Y = 8;

// Origin fraction inside the 32x32 gun overlay frame for the grip pixel. The
// gun graphic occupies frame x=3..21, so the grip sits at frame x≈3. Setting
// origin X = 3/32 ≈ 0.094 makes the rotation pivot land on the grip itself
// instead of the empty left edge, so the visible grip stays attached to the
// player's hand under rotation.
export const GUN_OVERLAY_GRIP_ORIGIN_X = 3 / 32;

export const SCENE_KEYS = {
  BOOT: 'BootScene',
  PRELOAD: 'PreloadScene',
  GAME: 'GameScene'
} as const;

// LDtk level identifier rendered by GameScene. The PreloadScene must inspect
// the same identifier when picking which tilesets to load — keep them aligned.
export const CURRENT_LEVEL_IDENTIFIER = 'Level_3';

// Render depth for the player and other dynamic entities. Tile layers occupy
// depth 0..N (back→front) using their LDtk layer position; this sits above
// all of them.
export const ENTITY_DEPTH = 100;
