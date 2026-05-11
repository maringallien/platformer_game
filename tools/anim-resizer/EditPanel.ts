import type { AnimationListing } from '../../src/sprites/characterLoader';
import {
  resolveValues,
  type AnimationEdit,
  type ResizerState,
} from './state';

export interface EditPanelCallbacks {
  readonly onPatch: (fullKey: string, patch: AnimationEdit) => void;
  readonly onResetAnimation: (fullKey: string) => void;
  readonly onCopyScaleToRegistry: (registryId: string, scale: number) => void;
  readonly onApplyAnchorsToUnset: (
    registryId: string,
    anchorX: number | null,
    anchorY: number | null,
  ) => void;
  readonly onResetAll: () => void;
  readonly onSave: () => void;
}

const PANEL_WIDTH = 320;

export class EditPanel {
  private readonly root: HTMLDivElement;
  private readonly emptyHint: HTMLDivElement;
  private readonly form: HTMLDivElement;
  private readonly selectedLabel: HTMLDivElement;
  private readonly scaleRange: HTMLInputElement;
  private readonly scaleNumber: HTMLInputElement;
  private readonly anchorXRange: HTMLInputElement;
  private readonly anchorXNumber: HTMLInputElement;
  private readonly anchorYRange: HTMLInputElement;
  private readonly anchorYNumber: HTMLInputElement;
  private readonly resetAnimBtn: HTMLButtonElement;
  private readonly copyScaleBtn: HTMLButtonElement;
  private readonly applyAnchorsBtn: HTMLButtonElement;
  private readonly resetAllBtn: HTMLButtonElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly diffList: HTMLDivElement;
  private readonly statusLine: HTMLDivElement;

  private callbacks: EditPanelCallbacks;
  private listingByKey: Map<string, AnimationListing> = new Map();
  private currentState: ResizerState | null = null;

  constructor(parent: HTMLElement, callbacks: EditPanelCallbacks) {
    this.callbacks = callbacks;
    this.root = document.createElement('div');
    this.root.className = 'anim-resizer-panel';
    this.root.style.cssText = [
      'position: fixed',
      'top: 41px',
      'right: 0',
      'bottom: 0',
      `width: ${PANEL_WIDTH}px`,
      'background: #0d0d0d',
      'border-left: 1px solid #2a2a2a',
      'color: #ddd',
      'padding: 12px',
      'box-sizing: border-box',
      'overflow-y: auto',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      'font-size: 12px',
      'z-index: 5',
    ].join(';');

    this.emptyHint = document.createElement('div');
    this.emptyHint.textContent = 'Click an animation to edit.';
    this.emptyHint.style.color = '#888';
    this.root.appendChild(this.emptyHint);

    this.form = document.createElement('div');
    this.form.style.display = 'none';
    this.root.appendChild(this.form);

    this.selectedLabel = document.createElement('div');
    this.selectedLabel.style.cssText = [
      'font-family: monospace',
      'font-size: 13px',
      'color: #9cdcfe',
      'margin-bottom: 12px',
      'word-break: break-all',
    ].join(';');
    this.form.appendChild(this.selectedLabel);

    const scaleRow = this.makeRow('displayScale', 0.1, 4, 0.05);
    this.scaleRange = scaleRow.range;
    this.scaleNumber = scaleRow.number;
    this.form.appendChild(scaleRow.row);

    const anchorXRow = this.makeRow('anchorX', 0, 0, 1);
    this.anchorXRange = anchorXRow.range;
    this.anchorXNumber = anchorXRow.number;
    this.form.appendChild(anchorXRow.row);

    const anchorYRow = this.makeRow('anchorY', 0, 0, 1);
    this.anchorYRange = anchorYRow.range;
    this.anchorYNumber = anchorYRow.number;
    this.form.appendChild(anchorYRow.row);

    this.resetAnimBtn = this.makeButton('Reset this animation');
    this.copyScaleBtn = this.makeButton('Copy scale to registry');
    this.applyAnchorsBtn = this.makeButton('Apply anchors to unset in registry');
    this.form.appendChild(this.resetAnimBtn);
    this.form.appendChild(this.copyScaleBtn);
    this.form.appendChild(this.applyAnchorsBtn);

    const divider = document.createElement('hr');
    divider.style.cssText =
      'border: none; border-top: 1px solid #2a2a2a; margin: 16px 0;';
    this.root.appendChild(divider);

    const diffHeader = document.createElement('div');
    diffHeader.textContent = 'Pending edits';
    diffHeader.style.cssText =
      'font-weight: 600; color: #cccccc; margin-bottom: 6px;';
    this.root.appendChild(diffHeader);

    this.diffList = document.createElement('div');
    this.diffList.style.cssText =
      'font-family: monospace; font-size: 11px; color: #c0c0c0; line-height: 1.4;';
    this.root.appendChild(this.diffList);

    const actionsRow = document.createElement('div');
    actionsRow.style.cssText = 'display: flex; gap: 8px; margin-top: 12px;';
    this.resetAllBtn = this.makeButton('Reset all');
    this.saveBtn = this.makeButton('Save to disk');
    this.saveBtn.style.background = '#264f78';
    actionsRow.appendChild(this.resetAllBtn);
    actionsRow.appendChild(this.saveBtn);
    this.root.appendChild(actionsRow);

    this.statusLine = document.createElement('div');
    this.statusLine.style.cssText =
      'font-size: 11px; color: #888; margin-top: 8px; min-height: 14px;';
    this.root.appendChild(this.statusLine);

    parent.appendChild(this.root);
    this.wireEvents();
  }

  setListings(listings: ReadonlyArray<AnimationListing>): void {
    this.listingByKey = new Map(listings.map((l) => [l.fullKey, l]));
  }

  setStatus(text: string, isError = false): void {
    this.statusLine.textContent = text;
    this.statusLine.style.color = isError ? '#f48771' : '#888';
  }

  render(state: ResizerState): void {
    this.currentState = state;
    const selected = state.selectedKey
      ? this.listingByKey.get(state.selectedKey) ?? null
      : null;

    if (!selected) {
      this.emptyHint.style.display = 'block';
      this.form.style.display = 'none';
    } else {
      this.emptyHint.style.display = 'none';
      this.form.style.display = 'block';
      this.selectedLabel.textContent = selected.fullKey;
      const edit = state.edits.get(selected.fullKey);
      const resolved = resolveValues(selected, edit);

      this.scaleRange.value = resolved.displayScale.toFixed(2);
      this.scaleNumber.value = resolved.displayScale.toFixed(2);

      this.anchorXRange.max = String(selected.anim.frames.frameWidth);
      this.anchorXNumber.max = String(selected.anim.frames.frameWidth);
      this.anchorXRange.value = String(resolved.anchorX);
      this.anchorXNumber.value = String(resolved.anchorX);

      this.anchorYRange.max = String(selected.anim.frames.frameHeight);
      this.anchorYNumber.max = String(selected.anim.frames.frameHeight);
      this.anchorYRange.value = String(resolved.anchorY);
      this.anchorYNumber.value = String(resolved.anchorY);
    }

    this.renderDiffList(state);
  }

  private renderDiffList(state: ResizerState): void {
    if (state.edits.size === 0) {
      this.diffList.textContent = 'No pending edits.';
      this.diffList.style.color = '#666';
      return;
    }
    this.diffList.style.color = '#c0c0c0';
    const lines: string[] = [`${state.edits.size} animation(s) modified`];
    for (const [fullKey, edit] of state.edits) {
      const parts: string[] = [];
      if (edit.displayScale !== undefined)
        parts.push(`scale=${edit.displayScale.toFixed(2)}`);
      if (edit.anchorX !== undefined) parts.push(`anchorX=${edit.anchorX}`);
      if (edit.anchorY !== undefined) parts.push(`anchorY=${edit.anchorY}`);
      lines.push(`  ${fullKey}: ${parts.join(', ')}`);
    }
    this.diffList.textContent = lines.join('\n');
    this.diffList.style.whiteSpace = 'pre-wrap';
  }

  private wireEvents(): void {
    const onScale = (raw: string) => {
      const fullKey = this.currentState?.selectedKey;
      if (!fullKey) return;
      const value = clampNumber(parseFloat(raw), 0.1, 4);
      this.callbacks.onPatch(fullKey, { displayScale: value });
    };
    this.scaleRange.addEventListener('input', () =>
      onScale(this.scaleRange.value),
    );
    this.scaleNumber.addEventListener('change', () =>
      onScale(this.scaleNumber.value),
    );

    const onAnchorX = (raw: string) => {
      const fullKey = this.currentState?.selectedKey;
      if (!fullKey) return;
      const listing = this.listingByKey.get(fullKey);
      if (!listing) return;
      const value = clampInt(parseFloat(raw), 0, listing.anim.frames.frameWidth);
      this.callbacks.onPatch(fullKey, { anchorX: value });
    };
    this.anchorXRange.addEventListener('input', () =>
      onAnchorX(this.anchorXRange.value),
    );
    this.anchorXNumber.addEventListener('change', () =>
      onAnchorX(this.anchorXNumber.value),
    );

    const onAnchorY = (raw: string) => {
      const fullKey = this.currentState?.selectedKey;
      if (!fullKey) return;
      const listing = this.listingByKey.get(fullKey);
      if (!listing) return;
      const value = clampInt(parseFloat(raw), 0, listing.anim.frames.frameHeight);
      this.callbacks.onPatch(fullKey, { anchorY: value });
    };
    this.anchorYRange.addEventListener('input', () =>
      onAnchorY(this.anchorYRange.value),
    );
    this.anchorYNumber.addEventListener('change', () =>
      onAnchorY(this.anchorYNumber.value),
    );

    this.resetAnimBtn.addEventListener('click', () => {
      const fullKey = this.currentState?.selectedKey;
      if (!fullKey) return;
      this.callbacks.onResetAnimation(fullKey);
    });

    this.copyScaleBtn.addEventListener('click', () => {
      const fullKey = this.currentState?.selectedKey;
      if (!fullKey) return;
      const listing = this.listingByKey.get(fullKey);
      if (!listing) return;
      const edit = this.currentState?.edits.get(fullKey);
      const resolved = resolveValues(listing, edit);
      this.callbacks.onCopyScaleToRegistry(
        listing.registry.id,
        resolved.displayScale,
      );
    });

    this.applyAnchorsBtn.addEventListener('click', () => {
      const fullKey = this.currentState?.selectedKey;
      if (!fullKey) return;
      const listing = this.listingByKey.get(fullKey);
      if (!listing) return;
      const edit = this.currentState?.edits.get(fullKey);
      const resolved = resolveValues(listing, edit);
      this.callbacks.onApplyAnchorsToUnset(
        listing.registry.id,
        resolved.anchorXIsExplicit ? resolved.anchorX : null,
        resolved.anchorYIsExplicit ? resolved.anchorY : null,
      );
    });

    this.resetAllBtn.addEventListener('click', () => {
      this.callbacks.onResetAll();
    });
    this.saveBtn.addEventListener('click', () => {
      this.callbacks.onSave();
    });
  }

  private makeRow(
    label: string,
    min: number,
    max: number,
    step: number,
  ): {
    row: HTMLDivElement;
    range: HTMLInputElement;
    number: HTMLInputElement;
  } {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom: 12px;';

    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    labelEl.style.cssText =
      'display: block; font-size: 11px; color: #aaa; margin-bottom: 4px;';
    row.appendChild(labelEl);

    const controls = document.createElement('div');
    controls.style.cssText =
      'display: flex; gap: 8px; align-items: center;';

    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.style.flex = '1';

    const number = document.createElement('input');
    number.type = 'number';
    number.min = String(min);
    number.max = String(max);
    number.step = String(step);
    number.style.cssText =
      'width: 64px; background: #1e1e1e; color: #ddd; border: 1px solid #333; padding: 2px 4px;';

    range.addEventListener('input', () => {
      number.value = range.value;
    });
    number.addEventListener('change', () => {
      range.value = number.value;
    });

    controls.appendChild(range);
    controls.appendChild(number);
    row.appendChild(controls);
    return { row, range, number };
  }

  private makeButton(text: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = [
      'display: block',
      'width: 100%',
      'margin-top: 6px',
      'padding: 6px 8px',
      'background: #1e1e1e',
      'color: #ddd',
      'border: 1px solid #333',
      'cursor: pointer',
      'font-size: 12px',
      'text-align: left',
    ].join(';');
    btn.addEventListener('mouseenter', () => {
      btn.style.background = '#2a2a2a';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = '#1e1e1e';
    });
    return btn;
  }
}

function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.round(Math.max(min, Math.min(max, value)));
}
