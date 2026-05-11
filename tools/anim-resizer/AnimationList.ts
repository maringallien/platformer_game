import type { AnimationListing } from '../../src/sprites/characterLoader';
import type { ResizerState } from './state';

export interface AnimationListCallbacks {
  readonly onSelect: (fullKey: string) => void;
}

export class AnimationList {
  private readonly root: HTMLDivElement;
  private listings: ReadonlyArray<AnimationListing> = [];
  private rowsByKey: Map<string, HTMLDivElement> = new Map();
  private readonly callbacks: AnimationListCallbacks;

  constructor(parent: HTMLElement, callbacks: AnimationListCallbacks) {
    this.callbacks = callbacks;
    this.root = document.createElement('div');
    this.root.className = 'anim-resizer-list';
    this.root.style.cssText = [
      'position: fixed',
      'top: 41px',
      'left: 0',
      'bottom: 0',
      'width: 280px',
      'background: #0d0d0d',
      'border-right: 1px solid #2a2a2a',
      'color: #ddd',
      'padding: 8px 0',
      'box-sizing: border-box',
      'overflow-y: auto',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      'font-size: 12px',
      'z-index: 5',
    ].join(';');
    parent.appendChild(this.root);
  }

  setListings(listings: ReadonlyArray<AnimationListing>): void {
    this.listings = listings;
    this.buildDom();
  }

  render(state: ResizerState): void {
    for (const [fullKey, row] of this.rowsByKey) {
      const isSelected = state.selectedKey === fullKey;
      const isDirty = state.edits.has(fullKey);
      row.style.background = isSelected ? '#264f78' : 'transparent';
      row.style.color = isSelected ? '#ffffff' : isDirty ? '#ffd866' : '#cccccc';
      const marker = row.querySelector<HTMLSpanElement>('.dirty-marker');
      if (marker) marker.style.visibility = isDirty ? 'visible' : 'hidden';
    }
  }

  private buildDom(): void {
    this.root.innerHTML = '';
    this.rowsByKey.clear();

    // Group by registry, preserving listing order.
    const groups = new Map<string, AnimationListing[]>();
    const groupOrder: string[] = [];
    for (const listing of this.listings) {
      const key = listing.registry.id;
      if (!groups.has(key)) {
        groups.set(key, []);
        groupOrder.push(key);
      }
      groups.get(key)?.push(listing);
    }

    for (const groupKey of groupOrder) {
      const items = groups.get(groupKey) ?? [];
      const header = document.createElement('div');
      header.textContent = groupKey;
      header.style.cssText = [
        'padding: 8px 12px 4px',
        'font-family: monospace',
        'font-size: 11px',
        'color: #9cdcfe',
        'border-top: 1px solid #1e1e1e',
      ].join(';');
      this.root.appendChild(header);

      for (const listing of items) {
        this.root.appendChild(this.makeRow(listing));
      }
    }
  }

  private makeRow(listing: AnimationListing): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = [
      'padding: 4px 12px',
      'font-family: monospace',
      'font-size: 12px',
      'cursor: pointer',
      'display: flex',
      'justify-content: space-between',
      'align-items: center',
    ].join(';');
    row.addEventListener('click', () =>
      this.callbacks.onSelect(listing.fullKey),
    );
    row.addEventListener('mouseenter', () => {
      // Don't override the selected highlight.
      if (!row.style.background.includes('#264f78')) {
        row.style.background = '#1a1a1a';
      }
    });
    row.addEventListener('mouseleave', () => {
      if (!row.style.background.includes('#264f78')) {
        row.style.background = 'transparent';
      }
    });

    const label = document.createElement('span');
    label.textContent = listing.anim.key;
    row.appendChild(label);

    const marker = document.createElement('span');
    marker.className = 'dirty-marker';
    marker.textContent = '•';
    marker.style.cssText = 'color: #ffd866; visibility: hidden;';
    row.appendChild(marker);

    this.rowsByKey.set(listing.fullKey, row);
    return row;
  }
}
