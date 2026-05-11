import type { AnimationListing } from '../../src/sprites/characterLoader';

export interface AnimationEdit {
  readonly displayScale?: number;
  readonly anchorX?: number;
  readonly anchorY?: number;
}

export interface ResizerState {
  readonly edits: ReadonlyMap<string, AnimationEdit>;
  readonly selectedKey: string | null;
}

export interface ResolvedAnimationValues {
  readonly displayScale: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly anchorXIsExplicit: boolean;
  readonly anchorYIsExplicit: boolean;
}

export const INITIAL_STATE: ResizerState = {
  edits: new Map(),
  selectedKey: null,
};

export function setSelected(
  state: ResizerState,
  selectedKey: string | null,
): ResizerState {
  if (state.selectedKey === selectedKey) return state;
  return { edits: state.edits, selectedKey };
}

export function patchEdit(
  state: ResizerState,
  fullKey: string,
  patch: AnimationEdit,
): ResizerState {
  const next = new Map(state.edits);
  const existing = next.get(fullKey) ?? {};
  const merged: AnimationEdit = { ...existing, ...patch };
  if (
    merged.displayScale === undefined &&
    merged.anchorX === undefined &&
    merged.anchorY === undefined
  ) {
    next.delete(fullKey);
  } else {
    next.set(fullKey, merged);
  }
  return { edits: next, selectedKey: state.selectedKey };
}

export function clearEdit(
  state: ResizerState,
  fullKey: string,
): ResizerState {
  if (!state.edits.has(fullKey)) return state;
  const next = new Map(state.edits);
  next.delete(fullKey);
  return { edits: next, selectedKey: state.selectedKey };
}

export function resolveValues(
  listing: AnimationListing,
  edit: AnimationEdit | undefined,
): ResolvedAnimationValues {
  const { frameWidth, frameHeight, anchorX, anchorY, displayScale } =
    listing.anim.frames;
  const effectiveAnchorX =
    edit?.anchorX ?? anchorX ?? frameWidth / 2;
  const effectiveAnchorY =
    edit?.anchorY ?? anchorY ?? frameHeight;
  const effectiveScale = edit?.displayScale ?? displayScale ?? 1;
  return {
    displayScale: effectiveScale,
    anchorX: effectiveAnchorX,
    anchorY: effectiveAnchorY,
    anchorXIsExplicit: edit?.anchorX !== undefined || anchorX !== undefined,
    anchorYIsExplicit: edit?.anchorY !== undefined || anchorY !== undefined,
  };
}

// Bulk-apply helpers used by the EditPanel buttons. Each returns a new state;
// callers are responsible for triggering a render after.

export function copyScaleToRegistry(
  state: ResizerState,
  registryId: string,
  listings: ReadonlyArray<AnimationListing>,
  scale: number,
): ResizerState {
  let next = state;
  for (const listing of listings) {
    if (listing.registry.id !== registryId) continue;
    next = patchEdit(next, listing.fullKey, { displayScale: scale });
  }
  return next;
}

export function applyAnchorsToUnset(
  state: ResizerState,
  registryId: string,
  listings: ReadonlyArray<AnimationListing>,
  anchorX: number | null,
  anchorY: number | null,
): ResizerState {
  let next = state;
  for (const listing of listings) {
    if (listing.registry.id !== registryId) continue;
    const existing = next.edits.get(listing.fullKey);
    let patchX: number | undefined;
    let patchY: number | undefined;
    if (
      anchorX !== null &&
      listing.anim.frames.anchorX === undefined &&
      existing?.anchorX === undefined
    ) {
      patchX = anchorX;
    }
    if (
      anchorY !== null &&
      listing.anim.frames.anchorY === undefined &&
      existing?.anchorY === undefined
    ) {
      patchY = anchorY;
    }
    if (patchX !== undefined || patchY !== undefined) {
      const patch: AnimationEdit = { anchorX: patchX, anchorY: patchY };
      next = patchEdit(next, listing.fullKey, patch);
    }
  }
  return next;
}
