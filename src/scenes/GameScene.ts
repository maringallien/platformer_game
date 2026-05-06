import Phaser from 'phaser';
import {
  CAMERA_ZOOM,
  CURRENT_LEVEL_IDENTIFIER,
  ENTITY_DEPTH,
  SCENE_KEYS,
} from '../constants';
import { spawnEntities } from '../entities/EntityFactory';
import { Player } from '../entities/Player';
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
import { buildIntGridCollision } from '../level/LevelCollision';
import { renderLevel } from '../level/LevelRenderer';
import { tilesetTextureKey } from '../level/TilesetRegistry';

export class GameScene extends Phaser.Scene {
  private player!: Player;
  private collisionLayer!: Phaser.Tilemaps.TilemapLayer;
  // Plain GameObjects.Group, not a physics group: Phaser.Physics.Arcade.Group's
  // createCallback re-applies its `defaults` to every added child's body —
  // including allowGravity:true and velocityX/Y:0 — clobbering the projectile's
  // own setup. Projectile creates its own dynamic body, so the group only needs
  // to be a collider container.
  private projectiles!: Phaser.GameObjects.Group;

  constructor() {
    super({ key: SCENE_KEYS.GAME });
  }

  create(): void {
    const project = parseLdtkProject(ldtkRaw);
    const level = getLevel(project, CURRENT_LEVEL_IDENTIFIER);

    this.physics.world.setBounds(0, 0, level.pxWid, level.pxHei);

    renderLevel(this, project, level);

    const intGrid = getIntGrid(level);
    if (!intGrid) {
      throw new Error(
        `Level "${level.identifier}" has no IntGrid layer — cannot establish collision`,
      );
    }
    // Collision tilemap reuses any loaded tileset texture (the layer is
    // invisible — texture is just to satisfy the Phaser Tilemap API).
    const tilesetUid = project.defs.tilesets.find((ts) => ts.relPath != null)?.uid;
    if (tilesetUid == null) {
      throw new Error(
        'No tileset with a loadable relPath — cannot back the invisible collision tilemap',
      );
    }
    this.collisionLayer = buildIntGridCollision(
      this,
      intGrid,
      tilesetTextureKey(tilesetUid),
    );

    this.projectiles = this.add.group();

    const spawned = spawnEntities(this, getEntities(level));
    if (!spawned.player) {
      throw new Error(
        `Level "${level.identifier}" did not spawn a Player — register a Player factory or place a player spawn entity`,
      );
    }
    this.player = spawned.player;
    this.player.setDepth(ENTITY_DEPTH);

    this.physics.add.collider(this.player, this.collisionLayer);
    this.physics.add.collider(
      this.projectiles,
      this.collisionLayer,
      this.onProjectilePlatformImpact,
      undefined,
      this,
    );

    this.cameras.main.setBounds(0, 0, level.pxWid, level.pxHei);
    this.cameras.main.setZoom(CAMERA_ZOOM);
    this.cameras.main.startFollow(this.player, true, 0.1, 0.1);
  }

  update(): void {
    this.player.update();
  }

  spawnProjectile(options: ProjectileSpawnOptions): void {
    const projectile = new Projectile(this, options);
    projectile.setDepth(ENTITY_DEPTH);
    this.projectiles.add(projectile);
  }

  private onProjectilePlatformImpact: Phaser.Types.Physics.Arcade.ArcadePhysicsCallback =
    (projectile) => {
      if (projectile instanceof Projectile) {
        projectile.onImpact();
      }
    };
}
