// Gentle Shell's own chrome, kept clear of the chat.
//
// In fullscreen Gentle paints a header row above the transcript and, from 140 columns, a Status rail on
// the right. Both are its layout, not Pi's, so the overlay would cover them. Gentle publishes that layout
// for other extensions on the shared terminal, under a global-registry symbol (lib/shell-sidebar.ts; its
// history picker reads the same contract). Read defensively: anything absent or malformed is "no chrome",
// so the chat falls back to the whole area and never refuses to open because of Gentle.

export const GENTLE_SIDEBAR_STATE = Symbol.for("gentle-pi.experimental-sidebar.state");

/** Gentle paints its header this many columns short of the edge (HEADER_RIGHT_INSET). */
const HEADER_RIGHT_INSET = 2;

export interface Insets {
  /** Header rows at the top of the screen. */
  top: number;
  /** Rail columns (rail plus gap) at the right edge. */
  right: number;
}

interface SidebarStateShape {
  active?: unknown;
  ownsHost?: unknown;
  railColumns?: unknown;
  parts?: unknown;
}

function railColumns(state: SidebarStateShape, columns: number): number {
  if (state.active !== true || typeof state.ownsHost !== "function") return 0;
  const rail = state.railColumns;
  if (typeof rail !== "number" || !Number.isInteger(rail) || rail <= 0 || rail >= columns) return 0;
  try {
    return state.ownsHost() === true ? rail : 0;
  } catch {
    return 0;
  }
}

function headerRows(state: SidebarStateShape, columns: number): number {
  const parts = state.parts;
  if (!(parts instanceof Map)) return 0;
  const header: unknown = parts.get("header");
  if (typeof header !== "object" || header === null) return 0;
  const render = (header as { render?: unknown }).render;
  if (typeof render !== "function") return 0;
  try {
    const lines: unknown = render.call(header, Math.max(0, columns - HEADER_RIGHT_INSET));
    if (!Array.isArray(lines)) return 0;
    // Gentle drops a header with nothing to show; so does this.
    return lines.some((line) => typeof line === "string" && line.trim() !== "") ? lines.length : 0;
  } catch {
    return 0;
  }
}

/**
 * The rows and columns Gentle's chrome takes right now. Only fullscreen has a fixed header and rail;
 * regular mode scrolls them with the transcript, so there is nothing to keep clear.
 *
 * Known gap: with Gentle's header placed "below-input" the header part is still registered but not on
 * top, so the chat leaves that many blank rows above it. Gentle does not publish its placement.
 */
export function gentleInsets(terminal: unknown, columns: number, mode: string | undefined): Insets {
  if (mode !== "fullscreen" || typeof terminal !== "object" || terminal === null) return { top: 0, right: 0 };
  const state = (terminal as Record<symbol, unknown>)[GENTLE_SIDEBAR_STATE];
  if (typeof state !== "object" || state === null) return { top: 0, right: 0 };
  return { top: headerRows(state, columns), right: railColumns(state, columns) };
}
