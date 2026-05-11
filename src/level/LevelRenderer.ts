import Phaser from 'phaser';
import { DYNAMIC_ENTITY_IDENTIFIERS } from '../entities/EntityFactory';
import {
  getRenderableEntityLayers,
  getRenderableLayers,
  getTilesetDefs,
  type RenderableEntityTile,
} from '../ldtk/parseLdtk';
import type {
  LdtkLayerType,
  LdtkLevel,
  LdtkProject,
} from '../ldtk/types';
import { tilesetTextureKey } from './TilesetRegistry';

const FLIP_HORIZONTAL = 1;
const FLIP_VERTICAL = 2;

// Per-level mask is inflated by this many pixels on every side so adjacent
// levels' masks overlap at every shared edge — kills the 1-pixel seam where
// the scene clear color was bleeding through between two pixel-aligned but
// non-overlapping masks.
const MASK_OVERLAP_PX = 1;

export interface RenderedLayer {
  identifier: string;
  type: LdtkLayerType;
  // One Container per LDtk layer. Children are added in autoLayerTiles order
  // so stacked tiles paint bottom-to-top, matching LDtk's editor behavior.
  container: Phaser.GameObjects.Container;
}

export interface RenderedLevel {
  widthPx: number;
  heightPx: number;
  layers: ReadonlyArray<RenderedLayer>;
  // Hidden Graphics that backs a per-level GeometryMask, applied to every
  // layer container so visuals never render outside the level's rect. With
  // the camera now allowed to scroll into adjacent levels, any LDtk-authored
  // spillage (parallax tiles, decoration entities placed past the level
  // bounds) would otherwise become visible in inter-level gaps.
  maskGraphics: Phaser.GameObjects.Graphics;
}

// Renders each LDtk tile as an individual Image at its exact px position.
// Why not Phaser Tilemap: LDtk auto-rules can produce sub-grid placements
// (rule pivot offsets) and per-cell stacks (Stamp rules with multi-tile
// outputs). Tilemap is grid-locked and one-tile-per-cell, so it silently
// drops both. Image-per-tile preserves what the LDtk editor shows. Collision
// is handled separately by LevelCollision (IntGrid CSV → invisible tilemap),
// so visual fidelity here doesn't have to compromise with physics structure.
export function renderLevel(
  scene: Phaser.Scene,
  project: LdtkProject,
  level: LdtkLevel,
): RenderedLevel {
  const tilesetDefs = getTilesetDefs(project);
  const renderable = getRenderableLayers(level);
  const out: RenderedLayer[] = [];

  for (const src of renderable) {
    const tilesetDef = tilesetDefs.get(src.tilesetUid);
    if (!tilesetDef) {
      throw new Error(
        `Layer "${src.identifier}" references tileset uid=${src.tilesetUid}, which is not defined`,
      );
    }
    const textureKey = tilesetTextureKey(tilesetDef.uid);
    if (!scene.textures.exists(textureKey)) {
      throw new Error(
        `Tileset texture "${textureKey}" not loaded — was preloadTilesets() called for level "${level.identifier}"?`,
      );
    }

    // Place each level's container at its world coordinates so multiple
    // levels rendered in the same scene line up like LDtk's world view.
    const container = scene.add.container(level.worldX, level.worldY);
    // Depth comes from the layer's position in level.layerInstances so
    // layers stack at the LDtk-authored position.
    container.setDepth(src.depth);

    for (const t of src.tiles) {
      const img = scene.add.image(t.px[0], t.px[1], textureKey, t.t);
      img.setOrigin(0, 0);
      if ((t.f & FLIP_HORIZONTAL) !== 0) img.setFlipX(true);
      if ((t.f & FLIP_VERTICAL) !== 0) img.setFlipY(true);
      container.add(img);
    }

    out.push({ identifier: src.identifier, type: src.type, container });
  }

  // Decoration entities (LDtk entities with embedded __tile references) live
  // in Entities-type layers and need their own rendering pass. Same Container-
  // per-layer + depth-by-layer-index scheme as the tile layers above, so the
  // user's LDtk-authored stacking between tile layers and decoration layers
  // is preserved.
  const entityLayers = getRenderableEntityLayers(
    level,
    DYNAMIC_ENTITY_IDENTIFIERS,
  );
  for (const src of entityLayers) {
    const container = scene.add.container(level.worldX, level.worldY);
    container.setDepth(src.depth);
    for (const dec of src.decorations) {
      const tilesetDef = tilesetDefs.get(dec.tilesetUid);
      if (!tilesetDef) {
        throw new Error(
          `Layer "${src.identifier}" entity tile references tileset uid=${dec.tilesetUid}, which is not defined`,
        );
      }
      const textureKey = tilesetTextureKey(tilesetDef.uid);
      if (!scene.textures.exists(textureKey)) {
        throw new Error(
          `Tileset texture "${textureKey}" not loaded — was preloadTilesets() called for level "${level.identifier}"?`,
        );
      }
      const img = createEntityTileImage(scene, textureKey, dec);
      container.add(img);
    }
    out.push({ identifier: src.identifier, type: 'Entities', container });
  }

  // Build a rectangular world-space mask matching the level's bounds and
  // apply it to every layer container. scene.make.graphics() (vs add) keeps
  // the mask source off the display list — its geometry is consumed by the
  // GeometryMask without rendering on its own. Color choice (white) is
  // arbitrary; geometry masks ignore color and use only fill coverage.
  //
  // The mask rect is inflated by MASK_OVERLAP_PX on every side so adjacent
  // levels' masks overlap at every shared edge. Without this, seam pixels
  // can land in a sub-pixel zone where neither mask wins, letting the scene
  // clear color show through as a 1-pixel line. The cost is a 1-px ring of
  // tolerated spillage outside each level — invisible in practice.
  const maskGraphics = scene.make.graphics();
  maskGraphics.fillStyle(0xffffff);
  maskGraphics.fillRect(
    level.worldX - MASK_OVERLAP_PX,
    level.worldY - MASK_OVERLAP_PX,
    level.pxWid + MASK_OVERLAP_PX * 2,
    level.pxHei + MASK_OVERLAP_PX * 2,
  );
  const mask = maskGraphics.createGeometryMask();
  for (const rendered of out) {
    rendered.container.setMask(mask);
  }

  return {
    widthPx: level.pxWid,
    heightPx: level.pxHei,
    layers: out,
    maskGraphics,
  };
}

// LDtk entity tiles use arbitrary src rects (tile.w/h can be larger than the
// tileset's tileGridSize). Phaser's spritesheet loader only produces fixed-
// size frames, so we register a custom-rect frame on the same texture for
// each unique entity-tile crop and reference it by name. Frames are cached
// across renders by their (uid + src rect) key — re-rendering after HMR
// reuses existing frames instead of duplicating them.
//
// Implements LDtk's tileRenderMode=FitInside: the source tile is scaled
// uniformly (preserving aspect ratio) to fit within the entity's bounding
// box, then anchored at the entity's pivot. Anchoring at the pivot — rather
// than centering the scaled tile inside the entity bounds — matters when
// pivot is non-centered: e.g. a ground prop with pivot=[0.5,1] and a tile
// taller-than-wide gets vertical letterbox; centering would make it float
// above the ground by half the letterbox height. Pivot-anchor keeps the
// pivot point on the ground regardless of aspect mismatch, which is what
// LDtk's editor shows. Every entity in this project uses FitInside; if that
// ever changes (Stretch, Cover, Repeat, etc.), this is the place to branch.
function createEntityTileImage(
  scene: Phaser.Scene,
  textureKey: string,
  dec: RenderableEntityTile,
): Phaser.GameObjects.Image {
  const frameName = `entityTile_${dec.srcX}_${dec.srcY}_${dec.srcW}_${dec.srcH}`;
  const texture = scene.textures.get(textureKey);
  if (!texture.has(frameName)) {
    texture.add(frameName, 0, dec.srcX, dec.srcY, dec.srcW, dec.srcH);
  }
  const scale = Math.min(dec.entityW / dec.srcW, dec.entityH / dec.srcH);
  const scaledW = dec.srcW * scale;
  const scaledH = dec.srcH * scale;
  const img = scene.add.image(dec.px, dec.py, textureKey, frameName);
  img.setOrigin(dec.pivotX, dec.pivotY);
  img.setDisplaySize(scaledW, scaledH);
  return img;
}

export function findRenderedLayer(
  rendered: RenderedLevel,
  identifier: string,
): RenderedLayer | undefined {
  return rendered.layers.find((l) => l.identifier === identifier);
}

// Symmetric teardown for renderLevel. Container.destroy(true) recursively
// destroys child Images, which is safe here because tile Images have no
// physics bodies (renderLevel uses scene.add.image, not physics.add.image).
// Collision tilemaps are owned by GameScene/LevelCollision and torn down
// separately — they don't appear in RenderedLevel.layers.
export function destroyRenderedLevel(rendered: RenderedLevel): void {
  // Clear masks before destroying the backing Graphics — leaving a mask
  // pointing at a destroyed Graphics makes the next render frame throw.
  // clearMask(false) leaves the mask object itself for GC; we destroy the
  // shared source Graphics explicitly below.
  for (const layer of rendered.layers) {
    layer.container.clearMask(false);
    layer.container.destroy(true);
  }
  rendered.maskGraphics.destroy();
}
