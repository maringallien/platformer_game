import Phaser from 'phaser';
import { listAnimations } from '../../src/sprites/characterLoader';
import { PreviewScene } from './PreviewScene';
import { EditPanel } from './EditPanel';
import { AnimationList } from './AnimationList';
import {
  applyAnchorsToUnset,
  clearEdit,
  copyScaleToRegistry,
  INITIAL_STATE,
  patchEdit,
  setSelected,
  type AnimationEdit,
  type ResizerState,
} from './state';
import { saveEdits } from './persist';

const CONTAINER_ID = 'anim-resizer-canvas';
const ZOOM_INPUT_ID = 'anim-resizer-zoom';
const LIST_WIDTH = 280;
const PANEL_WIDTH = 320;
const HEADER_HEIGHT = 41;
const ZOOM_BAR_HEIGHT = 32;
const DEFAULT_ZOOM = 6;
const MIN_ZOOM = 1;
const MAX_ZOOM = 16;

function bootstrap(): void {
  const container = document.getElementById(CONTAINER_ID);
  if (!container) {
    throw new Error(`Missing container element #${CONTAINER_ID}`);
  }

  const listings = listAnimations();
  // Default selection so the canvas isn't empty on first load.
  const initialSelectedKey = listings[0]?.fullKey ?? null;

  let state: ResizerState = {
    edits: INITIAL_STATE.edits,
    selectedKey: initialSelectedKey,
  };

  const setState = (next: ResizerState) => {
    if (next === state) return;
    state = next;
    panel.render(state);
    list.render(state);
    if (sceneInstance) sceneInstance.applyState(state);
  };

  const list = new AnimationList(document.body, {
    onSelect: (fullKey) => {
      setState(setSelected(state, fullKey));
    },
  });
  list.setListings(listings);

  const panel = new EditPanel(document.body, {
    onPatch: (fullKey, patch) => {
      setState(patchEdit(state, fullKey, patch));
    },
    onResetAnimation: (fullKey) => {
      setState(clearEdit(state, fullKey));
    },
    onCopyScaleToRegistry: (registryId, scale) => {
      setState(copyScaleToRegistry(state, registryId, listings, scale));
    },
    onApplyAnchorsToUnset: (registryId, anchorX, anchorY) => {
      setState(applyAnchorsToUnset(state, registryId, listings, anchorX, anchorY));
    },
    onResetAll: () => {
      setState({ edits: new Map(), selectedKey: state.selectedKey });
    },
    onSave: () => {
      void (async () => {
        if (state.edits.size === 0) {
          panel.setStatus('Nothing to save.');
          return;
        }
        panel.setStatus('Saving…');
        const result = await saveEdits(state, listings);
        if (result.ok) {
          const mode =
            result.mode === 'download'
              ? 'downloaded — drop into src/sprites/'
              : 'wrote files';
          panel.setStatus(
            `Saved ${result.written.length} registry/registries (${mode}).`,
          );
        } else {
          panel.setStatus(
            `Save failed: ${result.errors.join('; ') || 'unknown error'}`,
            true,
          );
        }
      })();
    },
  });
  panel.setListings(listings);

  // Style the canvas region so it sits between the list and panel, leaving
  // room for the zoom bar at the top.
  const centerLeft = LIST_WIDTH;
  const centerWidth = window.innerWidth - LIST_WIDTH - PANEL_WIDTH;
  const centerHeight = window.innerHeight - HEADER_HEIGHT - ZOOM_BAR_HEIGHT;
  container.style.cssText = [
    'position: fixed',
    `top: ${HEADER_HEIGHT + ZOOM_BAR_HEIGHT}px`,
    `left: ${centerLeft}px`,
    `width: ${centerWidth}px`,
    `height: ${centerHeight}px`,
    'background: #1e1e1e',
    'overflow: hidden',
  ].join(';');

  // Zoom bar above the canvas.
  const zoomBar = document.createElement('div');
  zoomBar.style.cssText = [
    'position: fixed',
    `top: ${HEADER_HEIGHT}px`,
    `left: ${LIST_WIDTH}px`,
    `width: ${centerWidth}px`,
    `height: ${ZOOM_BAR_HEIGHT}px`,
    'background: #0d0d0d',
    'border-bottom: 1px solid #2a2a2a',
    'display: flex',
    'align-items: center',
    'gap: 8px',
    'padding: 0 12px',
    'box-sizing: border-box',
    'color: #aaa',
    'font-family: -apple-system, BlinkMacSystemFont, sans-serif',
    'font-size: 12px',
    'z-index: 4',
  ].join(';');
  zoomBar.innerHTML = `
    <span>Preview zoom</span>
    <input id="${ZOOM_INPUT_ID}" type="range" min="${MIN_ZOOM}" max="${MAX_ZOOM}" step="0.5" value="${DEFAULT_ZOOM}" style="flex:1;max-width:240px"/>
    <span id="${ZOOM_INPUT_ID}-label" style="font-family:monospace">${DEFAULT_ZOOM.toFixed(1)}×</span>
  `;
  document.body.appendChild(zoomBar);

  let sceneInstance: PreviewScene | null = null;

  const scene = new PreviewScene({
    width: centerWidth,
    height: centerHeight,
    initialZoom: DEFAULT_ZOOM,
    onReady: () => {
      sceneInstance = scene;
      scene.setListings(listings);
      scene.applyState(state);
    },
    callbacks: {
      onAnchorDrag: (fullKey, patch: AnimationEdit) => {
        setState(patchEdit(state, fullKey, patch));
      },
    },
  });

  new Phaser.Game({
    type: Phaser.AUTO,
    parent: CONTAINER_ID,
    width: centerWidth,
    height: centerHeight,
    backgroundColor: '#1e1e1e',
    scale: {
      mode: Phaser.Scale.NONE,
      autoCenter: Phaser.Scale.NO_CENTER,
    },
    render: {
      pixelArt: true,
      antialias: false,
    },
    scene: [scene],
  });

  const zoomInput = document.getElementById(ZOOM_INPUT_ID) as HTMLInputElement;
  const zoomLabel = document.getElementById(`${ZOOM_INPUT_ID}-label`);
  zoomInput.addEventListener('input', () => {
    const zoom = parseFloat(zoomInput.value);
    if (Number.isFinite(zoom) && zoom > 0) {
      sceneInstance?.setZoom(zoom);
      if (zoomLabel) zoomLabel.textContent = `${zoom.toFixed(1)}×`;
    }
  });

  panel.render(state);
  list.render(state);
}

bootstrap();
