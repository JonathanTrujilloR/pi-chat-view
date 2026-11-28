// Pi's own transcript images, switched off while Chat covers them.
//
// A terminal draws images on a layer of its own, and pi-tui never composites an overlay over an image
// row (tui.js compositeTuiLine: `if (isImageLine(baseLine)) return baseLine`), so an image in Pi's
// transcript would show straight through the chat. Pi's ToolExecutionComponent draws result images and
// has `setShowImages(show)`, which Pi itself calls on every card when the setting changes
// (interactive-mode.js onShowImagesChange). The chat does the same while it is open, and puts back only
// what it switched. Duck typed and defensive: no Pi import, anything unexpected is left alone.

/** Deeper than Pi's document → chat container → card, with room for wrappers; a guard, not a layout. */
const MAX_DEPTH = 12;
/** Most nodes one walk visits. */
const MAX_NODES = 20000;

interface ImageCard {
  showImages: unknown;
  setShowImages(show: boolean): void;
}

export interface ImageHandle {
  /** Cards switched off and not yet restored. */
  readonly count: number;
  /** Switch off cards added since: new results while Chat stays open. Returns how many. */
  sweep(): number;
  /** Switch back on the cards this handle switched off (and that are still off). Idempotent. */
  restore(): void;
}

/** Any component in the tree, read field by field. */
type Node = Record<string, unknown>;

function isImageCard(node: Node): node is Node & ImageCard {
  try {
    return typeof node.setShowImages === "function" && node.showImages === true;
  } catch {
    return false;
  }
}

function childrenOf(node: Node): unknown[] {
  try {
    const children = node.children;
    return Array.isArray(children) ? children : [];
  } catch {
    return [];
  }
}

/**
 * What a walk saw of each node's children: the array and how far into it. Pi only appends to its
 * containers (and swaps the array out when it rebuilds the transcript), so a later walk starts at the
 * last child it saw, which may itself have grown, and skips everything before it.
 */
type Seen = WeakMap<object, { children: unknown[]; walked: number }>;

/** Image cards under `root` that still show images and were not seen before, breadth first, bounded. */
function findCards(root: unknown, seen: Seen): ImageCard[] {
  const found: ImageCard[] = [];
  const visited = new Set<object>();
  let level: unknown[] = [root];
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (typeof node !== "object" || node === null || visited.has(node) || visited.size >= MAX_NODES) continue;
      visited.add(node);
      if (isImageCard(node as Node)) found.push(node as Node & ImageCard);
      const children = childrenOf(node as Node);
      const before = seen.get(node);
      const from = before !== undefined && before.children === children && before.walked <= children.length ? Math.max(0, before.walked - 1) : 0;
      seen.set(node, { children, walked: children.length });
      for (let i = from; i < children.length; i++) next.push(children[i]);
    }
    level = next;
  }
  return found;
}

/** Switch off the images of every card under `root` (Pi's transcript, `TUI.children[0]`). */
export function hideImages(root: unknown): ImageHandle {
  const switched = new Set<ImageCard>();
  const seen: Seen = new WeakMap();
  let restored = false;
  const sweep = () => {
    if (restored) return 0;
    let n = 0;
    for (const card of findCards(root, seen)) {
      if (switched.has(card)) continue;
      try {
        card.setShowImages(false);
        switched.add(card);
        n++;
      } catch {
        // A card that refuses keeps its images; nothing else to do.
      }
    }
    return n;
  };
  sweep();
  return {
    get count() {
      return switched.size;
    },
    sweep,
    restore() {
      if (restored) return;
      restored = true;
      for (const card of switched) {
        try {
          if (card.showImages === false) card.setShowImages(true);
        } catch {
          // Left as it is.
        }
      }
      switched.clear();
    },
  };
}
