/// <reference lib="dom" />
/**
 * The panel's motion, for what the stylesheet cannot do by itself: the same curves as ui.css, as the scripts need
 * them. On Windows every pixel the page leaves clear is not there, and a pixel partly clear is darkened against the
 * key colour, so nothing here fades a card's edge: cards come and go by moving, by growing, and by being clipped.
 * With reduced motion asked for, nothing here moves (every movement's duration is nothing, and what depends on an
 * animation ending still runs), and what only fades, inside something opaque, still fades.
 */

const reduce = matchMedia("(prefers-reduced-motion: reduce)");

export const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)"; // what answers the user, what comes in, and what goes
/** A spring with a little bounce (Remotion's, sampled): only ever on a move, never on a size. */
export const SPRING = CSS.supports("transition-timing-function", "linear(0, 1)")
  ? "linear(0, 0.006 1.2%, 0.025 2.6%, 0.062 4.2%, 0.109 5.8%, 0.219 8.8%, 0.476 15%, 0.586 17.8%, 0.692 20.8%, 0.778 23.6%, 0.85 26.4%, 0.909 29.2%, 0.958 32.2%, 0.993 35.2%, 1.017 38%, 1.033 41%, 1.043 44.2%, 1.046 47.8%, 1.042 53.4%, 1.015 68%, 1.004 77%, 0.998 89%, 1)"
  : EASE_OUT;

export const GAP = 10; // between cards, as ui.css spaces them

/** A movement's duration, or none when the user has asked for less motion. A fade keeps its own. */
export const ms = (duration: number): number => (reduce.matches ? 0 : duration);

/** Whether the user has asked for less motion: for what shows a moment either way, and only moves when it may. */
export const still = (): boolean => reduce.matches;

/**
 * A new card is dealt: its place opens (so the cards above make way through the layout itself), then it slides
 * in from the right, revealed from its right edge. `wait` staggers cards that arrive together.
 */
export function deal(card: HTMLElement, wait = 0): void {
  const height = card.offsetHeight;
  card.animate([{ height: "0px", marginTop: `-${GAP}px` }, { height: `${height}px`, marginTop: "0px" }], { duration: ms(240 + wait), easing: EASE_OUT });
  card.animate([{ translate: "48px 0", clipPath: "inset(-8px -8px -8px 100%)" }, { translate: "0 0", clipPath: "inset(-8px -8px -8px -8px)" }], { duration: ms(437), delay: ms(80 + wait), easing: SPRING, fill: "backwards" });
}

/**
 * A card is swept off to the right, the way it came and quicker than it came, and its place closes after it.
 * Resolves once it is gone from the page.
 */
export async function sweep(card: HTMLElement): Promise<void> {
  card.inert = true;
  const height = card.offsetHeight;
  const off = card.animate([{ translate: "0 0", clipPath: "inset(-8px -8px -8px -8px)" }, { translate: "64px 0", clipPath: "inset(-8px -8px -8px 100%)" }], { duration: ms(200), easing: EASE_OUT, fill: "forwards" });
  const shut = card.animate([{ height: `${height}px`, marginTop: "0px" }, { height: "0px", marginTop: `-${GAP}px` }], { duration: ms(200), delay: ms(100), easing: EASE_OUT, fill: "forwards" });
  await Promise.allSettled([off.finished, shut.finished]);
  card.remove();
}

/** Where each of these stands on the screen now, to be moved from after the layout changes under them. */
export const where = (elements: Iterable<HTMLElement>): Map<HTMLElement, number> => new Map([...elements].map((element) => [element, element.getBoundingClientRect().top]));

/** Each element glides from where it stood to where the layout has put it now (a card moved up the column, or the column moved as the dock grew). */
export function glide(from: Map<HTMLElement, number>): void {
  for (const [element, top] of from) {
    if (!element.isConnected) continue;
    for (const running of element.getAnimations()) if (running.id === "glide") running.cancel();
    const by = top - element.getBoundingClientRect().top;
    if (Math.abs(by) < 1) continue;
    element.animate([{ transform: `translateY(${by}px)` }, { transform: "none" }], { id: "glide", duration: ms(280), easing: SPRING, composite: "add" });
  }
}

/**
 * A word that has just changed, set down: it comes up a few pixels into place, or, with less motion asked for, only
 * fades in. Inside an opaque header or dock, so it may fade.
 */
export function settle(element: HTMLElement): void {
  element.animate(still() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, translate: "0 5px" }, { opacity: 1, translate: "0 0" }], { duration: 160, easing: EASE_OUT });
}
