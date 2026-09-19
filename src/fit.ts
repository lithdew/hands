/**
 * From the frame to the tile: pure geometry.
 *
 * Events are shares of the hand's frame. A tile shows that frame fitted inside its well, all of it showing,
 * centred, which is how feed.cs places the thumbnail. Only positions are mapped through that fit; the pointer,
 * its tag and every stroke are drawn in the well's own pixels, so they are the same size in a 300 px tile and
 * on a whole screen.
 */
import type { Part, XY } from "./cursor.ts";

export interface Size {
  w: number;
  h: number;
}
export interface PixelRect extends Size {
  x: number;
  y: number;
}

/** Where a frame of this size sits in a box that shows all of it, centred. */
export function fitContain(frame: [number, number] | null | undefined, box: Size): PixelRect {
  if (!frame || !(frame[0] > 0) || !(frame[1] > 0) || !(box.w > 0) || !(box.h > 0)) return { x: 0, y: 0, w: Math.max(0, box.w), h: Math.max(0, box.h) };
  const scale = Math.min(box.w / frame[0], box.h / frame[1]);
  // Rounded as feed.cs rounds the thumbnail, or the pointer drifts a pixel off the picture.
  const w = Math.max(1, Math.round(frame[0] * scale));
  const h = Math.max(1, Math.round(frame[1] * scale));
  return { x: Math.max(0, Math.floor((box.w - w) / 2)), y: Math.max(0, Math.floor((box.h - h) / 2)), w, h };
}

export const toPixels = (point: XY, fit: PixelRect): XY => ({ x: fit.x + point.x * fit.w, y: fit.y + point.y * fit.h });
export const partToPixels = (part: Part, fit: PixelRect): PixelRect => ({ x: fit.x + part[0] * fit.w, y: fit.y + part[1] * fit.h, w: part[2] * fit.w, h: part[3] * fit.h });

/** An address as a person would say it: no scheme, no `www.`, no trailing slash. */
export const sayAddress = (url: string): string => url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
