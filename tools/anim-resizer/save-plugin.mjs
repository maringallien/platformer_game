import { readFile, writeFile } from 'node:fs/promises';
import { resolve as pathResolve, join as pathJoin } from 'node:path';

// Allow-list of registry → on-disk JSON file (path relative to project
// root). Path traversal is impossible because the registry parameter is
// checked against this map's keys before any filesystem access; the file
// path is constructed, not received.
const REGISTRY_FILES = {
  swordMaster: 'src/sprites/swordMaster.json',
  swordMasterMagic: 'src/sprites/swordMasterMagic.json',
  gunslingerBody: 'src/sprites/gunslingerBody.json',
  gunslingerGun1: 'src/sprites/gunslingerGun1.json',
  gunslingerGun2: 'src/sprites/gunslingerGun2.json',
  gun1Overlay: 'src/sprites/gun1Overlay.json',
  gun2Overlay: 'src/sprites/gun2Overlay.json',
  // Shared file holding every animated-entity LDtk identifier. The save
  // request must include `identifier` so the merge addresses the right
  // entry inside the file.
  entityRegistry: 'src/entities/entityRegistry.json',
};

// Permitted base directories for any resolved REGISTRY_FILES path. Any
// resolved file path must start with one of these after normalization;
// this is the belt-and-suspenders defense against path traversal.
const ALLOWED_BASE_DIRS = ['src/sprites', 'src/entities'];
const ENDPOINT = '/__anim-resizer/save';

function readRequestBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolveBody(Buffer.concat(chunks).toString('utf8'));
      } catch (err) {
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Validates the request payload. Returns { ok: true, payload } or
// { ok: false, message }. Strict — rejects unknown keys to prevent silent
// drift between the tool's edit shape and what gets persisted on disk.
// `identifier` is required when registry === 'entityRegistry' so the merge
// knows which LDtk identifier inside the shared file to update; it must
// be absent for every other registry.
function validate(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, message: 'Body must be a JSON object.' };
  }
  const { registry, animations, identifier } = raw;
  if (typeof registry !== 'string') {
    return { ok: false, message: 'registry must be a string.' };
  }
  if (!Object.prototype.hasOwnProperty.call(REGISTRY_FILES, registry)) {
    return { ok: false, message: `Unknown registry "${registry}".` };
  }
  if (registry === 'entityRegistry') {
    if (typeof identifier !== 'string' || identifier.length === 0) {
      return {
        ok: false,
        message: 'entityRegistry saves require a non-empty `identifier`.',
      };
    }
    // The LDtk identifier is used as a JSON property name lookup against
    // pre-existing keys in the shared file — never written as a new key —
    // so injection is structurally impossible. The format check below is
    // defense in depth against malformed clients.
    if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
      return {
        ok: false,
        message: 'identifier must match /^[A-Za-z0-9_]+$/.',
      };
    }
  } else if (identifier !== undefined) {
    return {
      ok: false,
      message: '`identifier` is only allowed for the entityRegistry save.',
    };
  }
  if (!animations || typeof animations !== 'object') {
    return { ok: false, message: 'animations must be an object.' };
  }
  for (const [animKey, edit] of Object.entries(animations)) {
    if (!edit || typeof edit !== 'object') {
      return { ok: false, message: `Edit for "${animKey}" must be an object.` };
    }
    for (const key of Object.keys(edit)) {
      if (key !== 'displayScale' && key !== 'anchorX' && key !== 'anchorY') {
        return { ok: false, message: `Unexpected field "${key}" on "${animKey}".` };
      }
    }
    if (edit.displayScale !== undefined) {
      if (!isFiniteNumber(edit.displayScale) || edit.displayScale <= 0) {
        return { ok: false, message: `displayScale on "${animKey}" must be > 0.` };
      }
    }
    if (edit.anchorX !== undefined) {
      if (!Number.isInteger(edit.anchorX) || edit.anchorX < 0) {
        return { ok: false, message: `anchorX on "${animKey}" must be a non-negative integer.` };
      }
    }
    if (edit.anchorY !== undefined) {
      if (!Number.isInteger(edit.anchorY) || edit.anchorY < 0) {
        return { ok: false, message: `anchorY on "${animKey}" must be a non-negative integer.` };
      }
    }
  }
  return {
    ok: true,
    payload: {
      registry,
      animations,
      ...(identifier !== undefined ? { identifier } : {}),
    },
  };
}

// Deep-merges ONLY the displayScale/anchorX/anchorY fields into each
// animation's `frames` block. Every other field on the animation object is
// preserved as-is, so stages, originalName, etc. survive untouched.
// Used for the per-character player registries where the top-level object
// IS the registry: { animations: {[animKey]: { frames: {...}, ... }} }.
function applyPlayerRegistryEdits(original, edits) {
  const out = { ...original, animations: { ...original.animations } };
  for (const [animKey, edit] of Object.entries(edits)) {
    const existing = original.animations?.[animKey];
    if (!existing) {
      throw new Error(`Animation "${animKey}" not found in registry.`);
    }
    const nextFrames = { ...existing.frames };
    if (edit.displayScale !== undefined) nextFrames.displayScale = edit.displayScale;
    if (edit.anchorX !== undefined) nextFrames.anchorX = edit.anchorX;
    if (edit.anchorY !== undefined) nextFrames.anchorY = edit.anchorY;
    out.animations[animKey] = { ...existing, frames: nextFrames };
  }
  return out;
}

// Entity registry shape: top-level object is a map of LDtk identifier →
// AnimatedEntityConfig, where each anim entry has frame fields directly on
// it (no nested `frames` wrapper). Edits address out[identifier].animations
// [animKey].{displayScale,anchorX,anchorY}.
function applyEntityRegistryEdits(original, identifier, edits) {
  const entry = original[identifier];
  if (!entry || typeof entry !== 'object') {
    throw new Error(
      `Identifier "${identifier}" not found in entityRegistry.json.`,
    );
  }
  if (!entry.animations || typeof entry.animations !== 'object') {
    throw new Error(
      `Identifier "${identifier}" has no animations to edit.`,
    );
  }
  const nextAnimations = { ...entry.animations };
  for (const [animKey, edit] of Object.entries(edits)) {
    const existing = entry.animations[animKey];
    if (!existing) {
      throw new Error(
        `Animation "${animKey}" not found on identifier "${identifier}".`,
      );
    }
    const next = { ...existing };
    if (edit.displayScale !== undefined) next.displayScale = edit.displayScale;
    if (edit.anchorX !== undefined) next.anchorX = edit.anchorX;
    if (edit.anchorY !== undefined) next.anchorY = edit.anchorY;
    nextAnimations[animKey] = next;
  }
  return {
    ...original,
    [identifier]: { ...entry, animations: nextAnimations },
  };
}

export function animResizerSavePlugin() {
  return {
    name: 'anim-resizer-save',
    // Conditional registration: the dev server only — never in production
    // builds. Avoids any chance of shipping a write endpoint with the game.
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root;
      server.middlewares.use(ENDPOINT, async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { error: 'Method not allowed' });
          return;
        }
        let payload;
        try {
          const body = await readRequestBody(req);
          payload = JSON.parse(body);
        } catch (err) {
          send(res, 400, { error: 'Invalid JSON', detail: String(err) });
          return;
        }
        const validation = validate(payload);
        if (!validation.ok) {
          send(res, 400, { error: validation.message });
          return;
        }
        const { registry, animations, identifier } = validation.payload;
        const relPath = REGISTRY_FILES[registry];
        const filePath = pathResolve(pathJoin(root, relPath));
        // Belt + suspenders: confirm the resolved path lives under one of
        // the allow-listed base directories after normalization.
        const inAllowedDir = ALLOWED_BASE_DIRS.some((baseDir) =>
          filePath.startsWith(pathResolve(pathJoin(root, baseDir))),
        );
        if (!inAllowedDir) {
          send(res, 400, {
            error: 'Resolved path escapes allowed save directories.',
          });
          return;
        }
        try {
          const raw = await readFile(filePath, 'utf8');
          const original = JSON.parse(raw);
          const merged =
            registry === 'entityRegistry'
              ? applyEntityRegistryEdits(original, identifier, animations)
              : applyPlayerRegistryEdits(original, animations);
          await writeFile(filePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
          send(res, 200, {
            ok: true,
            registry,
            ...(identifier !== undefined ? { identifier } : {}),
            count: Object.keys(animations).length,
          });
        } catch (err) {
          send(res, 500, { error: 'Save failed', detail: String(err) });
        }
      });
    },
  };
}
