import Phaser from 'phaser';
import {
  CAMERA_MAX_VERTICAL_LAG_PX,
  CAMERA_VERTICAL_OFFSET_PX,
  CAMERA_ZOOM,
  CURRENT_LEVEL_IDENTIFIER,
  ENTITY_DEPTH,
  PLAYER_PROJECTILE_DAMAGE,
  RESPAWN_DELAY_MS,
  SCENE_KEYS,
} from '../constants';
import { Enemy } from '../entities/Enemy';
import {
  EnemyProjectile,
  type EnemyProjectileSpawnOptions,
} from '../entities/EnemyProjectile';
import {
  destroyEntities,
  spawnEntities,
  type SpawnedEntities,
} from '../entities/EntityFactory';
import { PLAYER_DIED_EVENT, Player } from '../entities/Player';
import {
  Projectile,
  type ProjectileSpawnOptions,
} from '../entities/Projectile';
import { ldtkRaw } from '../ldtk/ldtkData';
import {
  getEntities,
  getIntGrid,
  getLevel,
  parseLdtkProject,
} from '../ldtk/parseLdtk';
import type { LdtkProject } from '../ldtk/types';
import { subscribeLdtkUpdate } from '../level/HotReloadBus';
import { buildIntGridCollision } from '../level/LevelCollision';
import {
  destroyRenderedLevel,
  renderLevel,
  type RenderedLevel,
} from '../level/LevelRenderer';
import {
  collectTilesetsForAllLevels,
  loadTilesetsAtRuntime,
  tilesetTextureKey,
} from '../level/TilesetRegistry';
import type { CharacterModeId } from '../sprites/characterTypes';

interface LevelSlot {
  worldX: number;
  worldY: number;
  pxWid: number;
  pxHei: number;
  rendered: RenderedLevel;
}

// Player state preserved across LDtk hot-reloads. Transient action state
// (locked attacks, combo counter, dash duration) is intentionally NOT
// preserved — restoring mid-attack into a freshly-built world is more
// confusing than letting the player drop back to idle for one frame.
interface PlayerSnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  flipX: boolean;
  mode: CharacterModeId;
}

// Pixels of camera-viewport padding when deciding whether a level is visible.
// Generous padding (roughly one viewport) ensures adjacent levels are already
// rendered by the time the camera reaches them — important during fast falls
// where the camera follow lags slightly behind the player and the cull would
// otherwise mark the destination level invisible until the camera catches up.
const LEVEL_VISIBILITY_PADDING_PX = 512;

export class GameScene extends Phaser.Scene {
  private player!: Player;
  // One collision tilemap per level (positioned at the level's worldX/Y).
  // Kept as a list so player and projectile colliders can be wired against
  // every level's geometry — letting the player fall from one level into
  // the next without seams.
  private collisionLayers: Phaser.Tilemaps.TilemapLayer[] = [];
  // Per-level visual data, used by update() to cull off-screen levels.
  // Without this culling the scene processes all ~74k tile sprites every
  // frame; toggling whole levels' container visibility lets Phaser skip the
  // children entirely, dropping per-frame work to just the visible levels.
  private levelSlots: LevelSlot[] = [];
  // Plain GameObjects.Group, not a physics group: Phaser.Physics.Arcade.Group's
  // createCallback re-applies its `defaults` to every added child's body —
  // including allowGravity:true and velocityX/Y:0 — clobbering the projectile's
  // own setup. Projectile creates its own dynamic body, so the group only needs
  // to be a collider container.
  private projectiles!: Phaser.GameObjects.Group;
  // Plain group, not a physics group — same reason as `projectiles` above:
  // Phaser.Physics.Arcade.Group's createCallback clobbers per-body settings,
  // and Enemy creates its own dynamic body via AnimatedEntity's constructor.
  private enemies!: Phaser.GameObjects.Group;
  // Enemy-fired projectiles. Separate from player `projectiles` so the
  // collider/overlap wiring stays per-faction: enemy projectiles damage the
  // player and pass through other enemies; player projectiles do the inverse.
  private enemyProjectiles!: Phaser.GameObjects.Group;
  // Tracks the entities returned by spawnEntities so HMR teardown can destroy
  // them in one call. Player is held separately on this.player for ergonomic
  // access; both reference the same instance.
  private spawned: SpawnedEntities | null = null;
  // Phaser doesn't auto-destroy colliders when their bodies vanish — leaked
  // colliders hold references to dead bodies and can throw nullrefs on the
  // next collision check. Track every collider so tearDownWorld can dispose
  // them explicitly.
  private colliders: Phaser.Physics.Arcade.Collider[] = [];
  private hotReloadUnsub: (() => void) | null = null;
  // HUD text for the player's HP. Created in create() (after buildWorld so
  // this.player exists), survives HMR untouched (tearDownWorld does not
  // touch it), and is auto-destroyed by Phaser on scene shutdown/restart.
  private healthText: Phaser.GameObjects.Text | null = null;
  // Last value rendered to healthText. Per-frame setText would re-rasterize
  // the texture unnecessarily; only update when the value actually changes.
  private lastRenderedHealth = -1;

  constructor() {
    super({ key: SCENE_KEYS.GAME });
  }

  create(): void {
    this.buildWorld(parseLdtkProject(ldtkRaw));
    this.setupHud();
    this.hotReloadUnsub = subscribeLdtkUpdate(this.onLdtkChange);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onSceneShutdown, this);
  }

  // HP readout pinned to the top-left of the screen. setScrollFactor(0)
  // anchors it to the camera viewport (it doesn't move when the world
  // scrolls); the high depth keeps it above gameplay sprites. Camera zoom
  // still applies, so the visible size is fontSize × CAMERA_ZOOM.
  private setupHud(): void {
    this.healthText = this.add.text(8, 8, '', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#ff8888',
      backgroundColor: '#000000aa',
      padding: { x: 6, y: 3 },
    });
    this.healthText.setScrollFactor(0);
    this.healthText.setDepth(10000);
  }

  private updateHud(): void {
    if (!this.healthText) return;
    const hp = this.player.getHealth();
    if (hp === this.lastRenderedHealth) return;
    this.healthText.setText(`HP: ${hp}/${this.player.getMaxHealth()}`);
    this.lastRenderedHealth = hp;
  }

  update(): void {
    this.player.update();
    this.updateEnemies();
    this.updateHud();
    this.clampCameraLag();
    this.cullOffscreenLevels();
  }

  // Per-frame AI tick for every spawned enemy. Group.getChildren() returns
  // the live array (mutations during destroy() are safe because Enemy's own
  // dead/hurt early-return prevents reentrant state changes here). The
  // instanceof guard keeps the loop tolerant of mixed groups in case a
  // future change adds non-Enemy children.
  private updateEnemies(): void {
    if (!this.enemies) return;
    const children = this.enemies.getChildren();
    for (const obj of children) {
      if (obj instanceof Enemy) {
        obj.update(this.player);
      }
    }
  }

  // The buttery 0.08 lerp can't keep up with terminal-velocity falls — left
  // alone, the steady-state lag is large enough to push the player off
  // screen. Clamp scrollY each frame so the camera can never sit more than
  // CAMERA_MAX_VERTICAL_LAG_PX above or below its ideal follow position.
  // Phaser's camera lerp re-runs after this and pulls back toward ideal, so
  // normal motion still feels smooth — the clamp only kicks in when the
  // player out-runs the lerp. Note: Phaser's own follow math targets
  // `(follow.y - offset.y) - height/2` using the raw pixel height (its
  // source explicitly states "values are in pixels and not impacted by
  // zooming"), so we mirror that — dividing by zoom here would put the clamp
  // band hundreds of pixels away from Phaser's lerp target and the two would
  // fight every frame.
  private clampCameraLag(): void {
    const cam = this.cameras.main;
    const idealScrollY =
      this.player.y - CAMERA_VERTICAL_OFFSET_PX - cam.height / 2;
    cam.scrollY = Phaser.Math.Clamp(
      cam.scrollY,
      idealScrollY - CAMERA_MAX_VERTICAL_LAG_PX,
      idealScrollY + CAMERA_MAX_VERTICAL_LAG_PX,
    );
  }

  // Camera-viewport culling: hide whole levels whose world rect doesn't
  // intersect the visible camera area. Phaser's renderer skips a Container's
  // children entirely when the container is invisible, so this drops per-frame
  // work from "all 19 levels' tiles" to "just the levels on screen". Collision
  // layers are left active because there are far fewer of them and toggling
  // them risks the player tunneling through a level on the boundary.
  //
  // Viewport is derived from cam.midPoint + displayWidth/Height, NOT from
  // scrollX/Y + width/zoom. Phaser stores scrollX as `follow.x - cam.width/2`
  // (canvas-pixel half-width, not zoom-adjusted), so `scrollX + cam.width/zoom`
  // undershoots the actual visible right edge by `(cam.width/2)(1 - 1/zoom)`
  // — at zoom 3 with a 1280 px canvas that's ~427 px, which silently consumed
  // almost all of the intended 512 px of padding and let neighboring levels
  // pop in only after the camera had already reached them.
  private cullOffscreenLevels(): void {
    const cam = this.cameras.main;
    const halfDispW = cam.displayWidth * 0.5;
    const halfDispH = cam.displayHeight * 0.5;
    const left = cam.midPoint.x - halfDispW - LEVEL_VISIBILITY_PADDING_PX;
    const top = cam.midPoint.y - halfDispH - LEVEL_VISIBILITY_PADDING_PX;
    const right = cam.midPoint.x + halfDispW + LEVEL_VISIBILITY_PADDING_PX;
    const bottom = cam.midPoint.y + halfDispH + LEVEL_VISIBILITY_PADDING_PX;

    for (const slot of this.levelSlots) {
      const visible =
        right > slot.worldX &&
        left < slot.worldX + slot.pxWid &&
        bottom > slot.worldY &&
        top < slot.worldY + slot.pxHei;
      for (const layer of slot.rendered.layers) {
        if (layer.container.visible !== visible) {
          layer.container.setVisible(visible);
        }
      }
    }
  }

  // True iff a solid collision tile exists at the given world coords. Iterates
  // collision layers because the world has one tilemap per level — most layers
  // return null instantly for out-of-bounds points, so the per-call cost is
  // dominated by the one layer that owns the sample point.
  isTileSolidAt(x: number, y: number): boolean {
    for (const layer of this.collisionLayers) {
      const tile = layer.getTileAtWorldXY(x, y);
      if (tile && tile.collides) return true;
    }
    return false;
  }

  // Coarse line-of-sight test: samples points along the segment (x1,y1)→(x2,y2)
  // and returns true if any sample lands on a solid collision tile. Sample
  // spacing is one tile (16 px in this project) so a 1-tile wall directly on
  // the line is always caught — finer spacing would only matter for sub-tile
  // geometry, which doesn't exist on the collision grid. False positives are
  // possible when the line clips a floor/ceiling tile (e.g. enemy on a ledge
  // above the player); chase will reject the path even though a curved walk
  // could close the gap. Acceptable for the current AI model.
  isLineBlocked(x1: number, y1: number, x2: number, y2: number): boolean {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const distance = Math.hypot(dx, dy);
    if (distance === 0) return false;
    const stepPx = 16;
    const steps = Math.ceil(distance / stepPx);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const sx = x1 + dx * t;
      const sy = y1 + dy * t;
      for (const layer of this.collisionLayers) {
        const tile = layer.getTileAtWorldXY(sx, sy);
        if (tile && tile.collides) return true;
      }
    }
    return false;
  }

  spawnProjectile(options: ProjectileSpawnOptions): void {
    const projectile = new Projectile(this, options);
    projectile.setDepth(ENTITY_DEPTH);
    this.projectiles.add(projectile);
  }

  // Structural entry point used by Enemy.fireProjectileAttack — kept here
  // (rather than on Enemy itself) so the collider/overlap wiring lives next
  // to the rest of the projectile setup and HMR teardown finds the group.
  spawnEnemyProjectile(options: EnemyProjectileSpawnOptions): void {
    const projectile = new EnemyProjectile(this, options);
    projectile.setDepth(ENTITY_DEPTH);
    this.enemyProjectiles.add(projectile);
  }

  // Constructs every level, collision tilemap, entity, and collider from a
  // parsed LDtk project. Idempotent: tearDownWorld() must run before this is
  // called a second time for the same scene instance.
  private buildWorld(project: LdtkProject): void {
    // Compute the union of all level rects so physics/camera bounds cover the
    // full traversable world rather than a single level's box.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const lvl of project.levels) {
      if (lvl.worldX < minX) minX = lvl.worldX;
      if (lvl.worldY < minY) minY = lvl.worldY;
      if (lvl.worldX + lvl.pxWid > maxX) maxX = lvl.worldX + lvl.pxWid;
      if (lvl.worldY + lvl.pxHei > maxY) maxY = lvl.worldY + lvl.pxHei;
    }
    this.physics.world.setBounds(minX, minY, maxX - minX, maxY - minY);

    // Pick any tileset with a real image to back the invisible collision
    // tilemap (Phaser's Tilemap API requires a tileset image even when the
    // layer is never drawn). Reused across all per-level collision maps.
    const tilesetUid = project.defs.tilesets.find((ts) => ts.relPath != null)?.uid;
    if (tilesetUid == null) {
      throw new Error(
        'No tileset with a loadable relPath — cannot back the invisible collision tilemap',
      );
    }
    const collisionTextureKey = tilesetTextureKey(tilesetUid);

    // Render every level at its world coords. LevelRenderer offsets its
    // containers by level.worldX/Y so the multi-level world lines up.
    for (const lvl of project.levels) {
      const rendered = renderLevel(this, project, lvl);
      this.levelSlots.push({
        worldX: lvl.worldX,
        worldY: lvl.worldY,
        pxWid: lvl.pxWid,
        pxHei: lvl.pxHei,
        rendered,
      });

      const intGrid = getIntGrid(lvl);
      if (intGrid) {
        const collisionLayer = buildIntGridCollision(
          this,
          intGrid,
          collisionTextureKey,
          lvl.worldX,
          lvl.worldY,
        );
        this.collisionLayers.push(collisionLayer);
      }
    }

    this.projectiles = this.add.group();
    this.enemies = this.add.group();
    this.enemyProjectiles = this.add.group();

    // Spawn entities from every level so enemies/items in other levels exist
    // when the player walks into them. The player factory only fires for the
    // single Sword_master_spawn entity (currently in Level_3).
    const allEntities = project.levels.flatMap(getEntities);
    const spawned = spawnEntities(this, allEntities);
    for (const enemy of spawned.enemies) {
      enemy.setDepth(ENTITY_DEPTH);
      this.enemies.add(enemy);
    }
    const spawnLevel = getLevel(project, CURRENT_LEVEL_IDENTIFIER);
    if (!spawned.player) {
      throw new Error(
        `Level "${spawnLevel.identifier}" did not spawn a Player — register a Player factory or place a player spawn entity`,
      );
    }
    this.spawned = spawned;
    this.player = spawned.player;
    this.player.setDepth(ENTITY_DEPTH);

    for (const layer of this.collisionLayers) {
      this.colliders.push(this.physics.add.collider(this.player, layer));
      this.colliders.push(
        this.physics.add.collider(
          this.projectiles,
          layer,
          this.onProjectilePlatformImpact,
          undefined,
          this,
        ),
      );
      // Enemies collide with terrain so gravity-enabled enemies (e.g. dogs)
      // rest on platforms instead of tunnelling. Stationary gravity-off
      // entities are unaffected by this collider in practice (their velocity
      // is zero), so wiring it unconditionally keeps the setup uniform.
      this.colliders.push(this.physics.add.collider(this.enemies, layer));
      // Enemy projectiles explode on terrain — same treatment as the player's.
      this.colliders.push(
        this.physics.add.collider(
          this.enemyProjectiles,
          layer,
          this.onEnemyProjectilePlatformImpact,
          undefined,
          this,
        ),
      );
    }

    // Player projectiles damage enemies. Both groups already exist; the
    // overlap is registered after collider wiring so any ordering concerns
    // are explicit at the call site.
    this.colliders.push(
      this.physics.add.overlap(
        this.projectiles,
        this.enemies,
        this.onProjectileHitsEnemy,
        undefined,
        this,
      ),
    );
    // Enemy projectiles damage the player.
    this.colliders.push(
      this.physics.add.overlap(
        this.enemyProjectiles,
        this.player,
        this.onEnemyProjectileHitsPlayer,
        undefined,
        this,
      ),
    );

    this.cameras.main.setZoom(CAMERA_ZOOM);
    // Lerp values < 1 smooth the follow toward the target each frame. 0.08 on
    // both axes feels buttery and stops the camera snapping during jumps —
    // small bobs damp out before they're visible while sustained motion still
    // tracks. No deadzone: a deadzone pins the player at its edge instead of
    // returning to the follow offset, so a long fall would leave them stuck
    // at the bottom of the screen.
    this.cameras.main.startFollow(this.player, true, 0.08, 0.08);
    // Phaser subtracts followOffset from the follow target's position when
    // setting scroll — a positive Y offset pulls the camera up so the player
    // renders in the lower half of the viewport, giving headroom to see
    // upcoming jumps and platforms.
    this.cameras.main.setFollowOffset(0, CAMERA_VERTICAL_OFFSET_PX);
    // Camera bounds = union of every level's rect. The viewport may scroll
    // through inter-level gaps and show the scene's clear color there; the
    // tradeoff is that approaching any level boundary lets the player see
    // the next level coming, instead of a hard clamp at the seam.
    this.cameras.main.setBounds(
      minX,
      minY,
      maxX - minX,
      maxY - minY,
    );

    // PLAYER_DIED_EVENT → schedule scene restart after the death anim plays.
    // The captured `diedPlayer` lets the delayed callback ignore the trigger
    // when HMR has since rebuilt the world — comparing against the current
    // this.player avoids restarting a freshly-built scene because of a death
    // that fired in the previous world.
    const diedPlayer = this.player;
    this.player.once(PLAYER_DIED_EVENT, () => {
      this.time.delayedCall(RESPAWN_DELAY_MS, () => {
        if (this.player === diedPlayer) {
          this.scene.restart();
        }
      });
    });
  }

  // Reverses buildWorld in dependency order. Stops camera follow first to
  // avoid the camera holding a reference to a destroyed player; destroys
  // colliders before the bodies they reference; destroys tilemaps via both
  // the layer AND the parent tilemap (the layer-only destroy leaves the map
  // in scene's tilemap registry).
  private tearDownWorld(): void {
    this.cameras.main.stopFollow();

    for (const collider of this.colliders) {
      collider.destroy();
    }
    this.colliders = [];

    for (const layer of this.collisionLayers) {
      const map = layer.tilemap;
      layer.destroy();
      map.destroy();
    }
    this.collisionLayers = [];

    for (const slot of this.levelSlots) {
      destroyRenderedLevel(slot.rendered);
    }
    this.levelSlots = [];

    if (this.projectiles) {
      // clear(true, true) removes from group and destroys child Projectiles;
      // then destroy() disposes the now-empty group itself.
      this.projectiles.clear(true, true);
      this.projectiles.destroy();
    }

    if (this.enemyProjectiles) {
      // Same teardown shape as `projectiles` — destroy each EnemyProjectile
      // first (so its DESTROY handler unsubscribes WORLD_BOUNDS), then dispose
      // the empty group.
      this.enemyProjectiles.clear(true, true);
      this.enemyProjectiles.destroy();
    }

    if (this.enemies) {
      // Enemies are destroyed via destroyEntities below; clear(false, false)
      // empties the group without re-destroying its children (double-destroy
      // throws on the second call). Then destroy() disposes the empty group.
      this.enemies.clear(false, false);
      this.enemies.destroy();
    }

    if (this.spawned) {
      destroyEntities(this.spawned);
      this.spawned = null;
    }
  }

  private snapshotPlayer(): PlayerSnapshot | null {
    if (!this.player || !this.player.body) return null;
    return {
      x: this.player.x,
      y: this.player.y,
      vx: this.player.body.velocity.x,
      vy: this.player.body.velocity.y,
      flipX: this.player.flipX,
      mode: this.player.getCurrentMode(),
    };
  }

  private restorePlayer(
    snapshot: PlayerSnapshot,
    project: LdtkProject,
  ): void {
    if (!this.isInsideAnyLevel(snapshot.x, snapshot.y, project)) {
      if (import.meta.env.DEV) {
        console.info(
          '[HMR] Restored position outside the new world — keeping the LDtk spawn position.',
        );
      }
      return;
    }
    this.player.setPosition(snapshot.x, snapshot.y);
    this.player.setVelocity(snapshot.vx, snapshot.vy);
    this.player.setCurrentMode(snapshot.mode);
    // setFacing must come after setCurrentMode: switching mode plays a fresh
    // idle animation that re-anchors with the *current* flipX. Setting flip
    // last guarantees the final anchor matches the restored facing.
    this.player.setFacing(snapshot.flipX);
    this.cameras.main.centerOn(snapshot.x, snapshot.y);
  }

  private isInsideAnyLevel(
    x: number,
    y: number,
    project: LdtkProject,
  ): boolean {
    for (const lvl of project.levels) {
      if (
        x >= lvl.worldX &&
        x < lvl.worldX + lvl.pxWid &&
        y >= lvl.worldY &&
        y < lvl.worldY + lvl.pxHei
      ) {
        return true;
      }
    }
    return false;
  }

  // Arrow function so subscribeLdtkUpdate can store it directly without a
  // separate .bind(this) — and so the same reference is held across the
  // scene's lifetime (important for unsubscribe on shutdown).
  private onLdtkChange = async (rawJson: string): Promise<void> => {
    let project: LdtkProject;
    try {
      project = parseLdtkProject(rawJson);
    } catch (error) {
      // LDtk doesn't always save atomically; mid-write reads can yield
      // truncated JSON. Skip the reload silently — the next save (or the
      // debounce-coalesced trailing event) will deliver complete content.
      if (import.meta.env.DEV) {
        const message =
          error instanceof Error ? error.message : 'unknown error';
        console.warn(
          `[HMR] Skipping reload — LDtk JSON not yet valid: ${message}`,
        );
      }
      return;
    }

    // Snapshot before any teardown; the player still belongs to the old world
    // here. Capturing position now reflects what the user was doing when they
    // hit Save, even if the async tileset load below takes a frame or two.
    const playerSnapshot = this.snapshotPlayer();

    // Load any new tilesets BEFORE teardown so the existing world stays
    // visible during the async wait. If loading fails (e.g. user added a
    // layer referencing a PNG that isn't under public/), abort without
    // tearing anything down — the old world keeps running.
    try {
      const tilesets = collectTilesetsForAllLevels(project);
      await loadTilesetsAtRuntime(this, tilesets);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn(
          '[HMR] Tileset load failed; keeping the existing world.',
          error,
        );
      }
      return;
    }

    this.tearDownWorld();
    try {
      this.buildWorld(project);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error(
          '[HMR] buildWorld failed after teardown — game is now in a partial state. Reload the page to recover.',
          error,
        );
      }
      return;
    }

    if (playerSnapshot) {
      this.restorePlayer(playerSnapshot, project);
    }
  };

  private onSceneShutdown(): void {
    if (this.hotReloadUnsub) {
      this.hotReloadUnsub();
      this.hotReloadUnsub = null;
    }
  }

  private onProjectilePlatformImpact: Phaser.Types.Physics.Arcade.ArcadePhysicsCallback =
    (projectile) => {
      if (projectile instanceof Projectile) {
        projectile.onImpact();
      }
    };

  // Order of the (object1, object2) params follows the overlap registration:
  // physics.add.overlap(projectiles, enemies, ...) → (projectile, enemy).
  private onProjectileHitsEnemy: Phaser.Types.Physics.Arcade.ArcadePhysicsCallback =
    (projectileObj, enemyObj) => {
      if (!(projectileObj instanceof Projectile)) return;
      if (!(enemyObj instanceof Enemy)) return;
      // Defense-in-depth: Projectile.onImpact disables the body so this
      // callback shouldn't re-fire after the first hit. Re-check in case the
      // overlap is queued from before the body was disabled in the same tick.
      if (projectileObj.hasExploded()) return;
      if (enemyObj.isDead()) return;
      enemyObj.takeDamage(
        PLAYER_PROJECTILE_DAMAGE,
        projectileObj.x,
        projectileObj.y,
      );
      projectileObj.onImpact();
    };

  private onEnemyProjectilePlatformImpact: Phaser.Types.Physics.Arcade.ArcadePhysicsCallback =
    (projectile) => {
      if (projectile instanceof EnemyProjectile) {
        projectile.onImpact();
      }
    };

  // Overlap order follows the registration: (enemyProjectile, player). The
  // hasExploded guard mirrors onProjectileHitsEnemy — overlap callbacks can
  // be queued from a previous tick before the body was disabled in onImpact.
  // Player.hurt also gates on its own invuln window, so double-call here is
  // harmless, but exploding once keeps the projectile sprite from re-firing
  // damage if invuln expires while the explode animation is still playing.
  private onEnemyProjectileHitsPlayer: Phaser.Types.Physics.Arcade.ArcadePhysicsCallback =
    (projectileObj, playerObj) => {
      if (!(projectileObj instanceof EnemyProjectile)) return;
      if (!(playerObj instanceof Player)) return;
      if (projectileObj.hasExploded()) return;
      if (playerObj.isDead()) return;
      playerObj.hurt(
        projectileObj.getDamage(),
        projectileObj.x,
        projectileObj.y,
      );
      projectileObj.onImpact();
    };
}
