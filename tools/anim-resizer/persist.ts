import {
  ENTITY_LISTING_MODE_PREFIX,
  type AnimationListing,
} from '../../src/sprites/characterLoader';
import type { AnimationEdit, ResizerState } from './state';

const SAVE_ENDPOINT = '/__anim-resizer/save';

// Maps the registry's `mode` (the prefix used in fullKey) to the on-disk
// filename. Mirrors the Vite plugin's allow-list — both must stay in sync.
const REGISTRY_BY_MODE: Record<string, string> = {
  sword_master: 'swordMaster',
  sword_master_magic: 'swordMasterMagic',
  gunslinger_body: 'gunslingerBody',
  gunslinger_gun1: 'gunslingerGun1',
  gunslinger_gun2: 'gunslingerGun2',
  gun1_overlay: 'gun1Overlay',
  gun2_overlay: 'gun2Overlay',
};

// Shared registry name for every animated-entity edit. The save plugin
// knows how to route this to src/entities/entityRegistry.json and how to
// merge into the per-identifier shape (out[identifier].animations[animKey]).
const ENTITY_REGISTRY_NAME = 'entityRegistry';

interface RegistryPayload {
  readonly registry: string;
  readonly animations: Record<string, AnimationEdit>;
  // Original file content for the download fallback path so the merge result
  // is built client-side without re-fetching.
  readonly originalRaw: unknown;
  // Present only for entity-registry payloads — names which LDtk identifier
  // inside entityRegistry.json the animations belong to. Player payloads
  // omit this because each player registry is its own file.
  readonly identifier?: string;
}

export interface SaveResult {
  readonly ok: boolean;
  readonly mode: 'endpoint' | 'download';
  readonly written: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

// Group edits by registry. Each fullKey is `${mode}_${animKey}`; we derive
// the registry/mode from the listing rather than re-parsing the key.
// Player listings group by their registry name (one payload per player
// registry file). Entity listings group by LDtk identifier (one payload per
// identifier, all sharing the same `entityRegistry` target file).
export function buildPayloads(
  state: ResizerState,
  listings: ReadonlyArray<AnimationListing>,
): ReadonlyArray<RegistryPayload> {
  const listingByKey = new Map(listings.map((l) => [l.fullKey, l]));
  // Bucket key for player payloads = registry name (e.g. "swordMaster").
  // Bucket key for entity payloads = `entityRegistry:${identifier}` so
  // each LDtk identifier gets its own per-identifier payload that the
  // server merges into the shared file.
  const grouped = new Map<
    string,
    {
      registry: string;
      animations: Record<string, AnimationEdit>;
      original: unknown;
      identifier?: string;
    }
  >();
  for (const [fullKey, edit] of state.edits) {
    const listing = listingByKey.get(fullKey);
    if (!listing) continue;
    if (listing.isEntity && listing.entityIdentifier) {
      const bucketKey = `${ENTITY_REGISTRY_NAME}:${listing.entityIdentifier}`;
      const bucket = grouped.get(bucketKey);
      if (bucket) {
        bucket.animations[listing.anim.key] = edit;
      } else {
        grouped.set(bucketKey, {
          registry: ENTITY_REGISTRY_NAME,
          animations: { [listing.anim.key]: edit },
          // Entity payloads merge into the canonical entityRegistry.json on
          // the server, so the per-identifier original is not needed for the
          // endpoint path. Download-fallback handling (mergeForDownload)
          // also doesn't reach for this because entity edits live inside one
          // file the server alone knows how to read/write atomically.
          original: null,
          identifier: listing.entityIdentifier,
        });
      }
      continue;
    }
    const mode = listing.registry.mode ?? 'sword_master';
    if (mode.startsWith(ENTITY_LISTING_MODE_PREFIX)) continue;
    const registryName = REGISTRY_BY_MODE[mode];
    if (!registryName) continue;
    const bucket = grouped.get(registryName);
    if (bucket) {
      bucket.animations[listing.anim.key] = edit;
    } else {
      grouped.set(registryName, {
        registry: registryName,
        animations: { [listing.anim.key]: edit },
        original: listing.registry,
      });
    }
  }
  return Array.from(grouped.values(), (value) => ({
    registry: value.registry,
    animations: value.animations,
    originalRaw: value.original,
    ...(value.identifier !== undefined ? { identifier: value.identifier } : {}),
  }));
}

async function postOne(payload: RegistryPayload): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(SAVE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        registry: payload.registry,
        animations: payload.animations,
        ...(payload.identifier !== undefined
          ? { identifier: payload.identifier }
          : {}),
      }),
    });
    if (res.status === 404) {
      return { ok: false, message: 'endpoint-missing' };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, message: `${res.status}: ${text}` };
    }
    return { ok: true, message: '' };
  } catch (err) {
    // fetch rejects on network errors / CORS / unreachable. Treat as
    // endpoint-missing so the caller can fall back to download mode.
    return { ok: false, message: 'endpoint-missing' };
  }
}

// Merge edits into the original registry object client-side, for download.
// Mirrors the server-side applyEdits logic so the downloaded file matches
// what the server would have written. Returns null when there's nothing
// usable to write (e.g. entity-registry payloads, which don't carry a
// per-identifier original because the shared file is server-managed).
function mergeForDownload(
  original: unknown,
  edits: Record<string, AnimationEdit>,
): unknown {
  if (!original || typeof original !== 'object') return null;
  const orig = original as { animations?: Record<string, unknown> };
  const out: Record<string, unknown> = { ...orig };
  const nextAnims: Record<string, unknown> = { ...(orig.animations ?? {}) };
  for (const [animKey, edit] of Object.entries(edits)) {
    const existing = nextAnims[animKey];
    if (!existing || typeof existing !== 'object') continue;
    const e = existing as { frames?: Record<string, unknown> };
    const nextFrames = { ...(e.frames ?? {}) } as Record<string, unknown>;
    if (edit.displayScale !== undefined) nextFrames.displayScale = edit.displayScale;
    if (edit.anchorX !== undefined) nextFrames.anchorX = edit.anchorX;
    if (edit.anchorY !== undefined) nextFrames.anchorY = edit.anchorY;
    nextAnims[animKey] = { ...existing, frames: nextFrames };
  }
  out.animations = nextAnims;
  return out;
}

function downloadJson(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function saveEdits(
  state: ResizerState,
  listings: ReadonlyArray<AnimationListing>,
): Promise<SaveResult> {
  const payloads = buildPayloads(state, listings);
  if (payloads.length === 0) {
    return { ok: true, mode: 'endpoint', written: [], errors: [] };
  }
  const written: string[] = [];
  const errors: string[] = [];
  let endpointMissing = false;
  for (const payload of payloads) {
    const result = await postOne(payload);
    if (result.ok) {
      written.push(payload.registry);
    } else if (result.message === 'endpoint-missing') {
      endpointMissing = true;
      break;
    } else {
      errors.push(`${payload.registry}: ${result.message}`);
    }
  }
  if (endpointMissing) {
    // Fall back to downloading patched JSON files. User drops them into
    // src/sprites/ manually. Entity-registry payloads can't take this path
    // because the canonical file is server-managed and shared across all
    // identifiers — surface those as errors instead of writing junk.
    for (const payload of payloads) {
      if (payload.registry === ENTITY_REGISTRY_NAME) {
        errors.push(
          `${payload.identifier ?? 'entity'}: save endpoint missing — start the dev server to save entity edits`,
        );
        continue;
      }
      const merged = mergeForDownload(payload.originalRaw, payload.animations);
      if (merged == null) {
        errors.push(`${payload.registry}: nothing to write`);
        continue;
      }
      const json = `${JSON.stringify(merged, null, 2)}\n`;
      downloadJson(`${payload.registry}.json`, json);
      written.push(payload.registry);
    }
    return { ok: errors.length === 0, mode: 'download', written, errors };
  }
  return { ok: errors.length === 0, mode: 'endpoint', written, errors };
}
