/**
 * The orchestrator's body: what `live.ts` needs from this Mac that is not a hand. A key to hold, a microphone,
 * a speaker, a small panel in the corner of the screen that shows a web page, and a camera for other apps'
 * windows. All of it is bun:ffi over the runtime macos.ts binds.
 *
 * None of this has a thread of its own. AppKit, WebKit and the microphone's AudioQueue all deliver on the main run
 * loop, which is this process's JS thread, so `start` pumps that loop on a timer and every callback from the system
 * arrives inside a pump, as an ordinary synchronous call into JS. Nothing here may block for long. The one exception is
 * the speaker, which plays on the system's audio thread: what it has been given, it plays whatever this thread is doing.
 */

import { JSCallback, read, toArrayBuffer } from "bun:ffi";
import * as macos from "./macos.ts";

const { cls, sel, str, msg, fn, pooled, structOf } = macos.objc;
const call = (object: unknown, selector: string, signature = "void", ...args: unknown[]) => msg(signature)(object, sel(selector), ...args);

const PUMP_MS = 8;
const TALK_KEY = 0x40; // right Option, as the keyboard's own bit for it in the modifier flags (NX_DEVICERALTKEYMASK): a key nothing else is held down for
const TAP_MS = 250; // let go sooner than this and it was a slip, not a sentence
const SAMPLE_RATE = 24000; // what gpt-live-1 hears and speaks: mono, 16-bit
const CHUNK_BYTES = (SAMPLE_RATE * 2 * 40) / 1000; // 40 ms
const PREROLL_CHUNKS = 8; // what a warm microphone remembers: a third of a second
const CUSHION_MS = 200; // how far ahead of the speaker its queue is kept: one of the voice's stalls (130 to 190 ms, measured) fits
const LOW_MS = 20; // speech is only interrupted to restore that when the queue is this close to empty
const DEEP_MS = 2 * CUSHION_MS; // and a queue deeper than this, after a burst from the network, is let down in the pauses
const QUIET = 100 / 32768; // a chunk that never gets louder than this is a pause: near-digital silence, as the voice sends it
const THUMB_PX = 720;
const MARGIN_PT = 12;

type Pointer = number | bigint;
let app: unknown;
const mode = () => str("kCFRunLoopDefaultMode");

// ------------------------------------------------------------------ the key

export type Talk = "down" | "up" | "cancel";

/**
 * The push-to-talk key, polled: no event tap, so no permission and nothing to time out. It is read from the modifier
 * flags, where each side's Option has a bit of its own: the key-state table (CGEventSourceKeyState) never shows a
 * modifier as down, which is how this first shipped deaf. Option is also a modifier, so a key pressed while it is
 * held means the user is typing a character, not talking: that cancels. `fake` holds the key down from inside, for
 * a run that speaks from a file.
 */
function watchKey(onTalk: (talk: Talk) => void): { poll(): void; fake(down: boolean): void } {
  const flags = fn("CGEventSourceFlagsState", ["i32"], "u64");
  const keysTyped = (): number => Number(fn("CGEventSourceCounterForEventType", ["i32", "u32"], "u32")(0, 10)); // kCGEventKeyDown, which a modifier is not
  let [held, faked, cancelled, since, typed] = [false, false, false, 0, 0];
  return {
    fake: (down) => void (faked = down),
    poll() {
      const down = faked || (Number(BigInt(flags(0)) & 0xffffn) & TALK_KEY) !== 0; // the combined session state: the hardware, and anything posted
      if (down && !held) {
        [since, typed, cancelled] = [performance.now(), keysTyped(), false];
        onTalk("down");
      } else if (!down && held) {
        if (!cancelled) onTalk(performance.now() - since < TAP_MS ? "cancel" : "up");
      } else if (down && !cancelled && !faked && keysTyped() !== typed) {
        cancelled = true;
        onTalk("cancel");
      }
      held = down;
    },
  };
}

// ------------------------------------------------------------------ sound

/** AudioStreamBasicDescription for what the Live API speaks: linear PCM, signed 16-bit, packed, mono. */
const pcmFormat = (): Uint8Array => {
  const format = new DataView(new ArrayBuffer(40));
  format.setFloat64(0, SAMPLE_RATE, true);
  format.setUint32(8, 0x6c70636d, true); // 'lpcm'
  format.setUint32(12, 0x4 | 0x8, true); // signed integer | packed
  for (const [offset, value] of [[16, 2], [20, 1], [24, 2], [28, 1], [32, 16]] as const) format.setUint32(offset, value, true); // bytes/packet, frames/packet, bytes/frame, channels, bits
  return new Uint8Array(format.buffer);
};

/** An AudioQueueBuffer's fields: the data pointer at 8, the byte count at 16. */
const bufferData = (buffer: Pointer, bytes: number) => new Uint8Array(toArrayBuffer(read.ptr(buffer as never, 8) as never, 0, bytes));

/**
 * The speaker's one rule. With `left` ms queued, what goes in front of the next chunk: that many ms of silence, or null
 * to leave the chunk out, which is how a queue that a burst has made deep gets back to the cushion without a sound.
 */
export const cushion = (left: number, quiet: boolean): number | null =>
  quiet && left > DEEP_MS ? null : left < (quiet ? CUSHION_MS : LOW_MS) ? CUSHION_MS - left : 0;

function sound() {
  macos.objc.load("/System/Library/Frameworks/AudioToolbox.framework/AudioToolbox");
  const queue = {
    input: fn("AudioQueueNewInput", ["ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"], "i32"),
    allocate: fn("AudioQueueAllocateBuffer", ["ptr", "u32", "ptr"], "i32"),
    enqueue: fn("AudioQueueEnqueueBuffer", ["ptr", "ptr", "u32", "ptr"], "i32"),
    start: fn("AudioQueueStart", ["ptr", "ptr"], "i32"),
    stop: fn("AudioQueueStop", ["ptr", "bool"], "i32"),
  };
  const mainLoop = fn("CFRunLoopGetMain", [], "ptr")();
  const commonModes = macos.objc.constant("kCFRunLoopCommonModes");
  const out = new BigUint64Array(1);
  const made = (status: number, what: string): bigint => {
    if (status !== 0) throw new Error(`${what} failed (${status})`);
    return out[0]!;
  };

  // The microphone. Kept warm, it runs all the time and remembers its last third of a second, so that a press of the key
  // loses nothing to the microphone starting up (a tenth of a second, measured) or to a word begun before the key was
  // down; nothing it hears leaves this process until someone listens. Cold, it runs only while someone does, and the
  // system's "microphone in use" light with it.
  let hear: ((pcm: Uint8Array) => void) | null = null;
  let running = false;
  const kept: Uint8Array[] = [];
  const onInput = new JSCallback(
    (_user: Pointer, from: Pointer, buffer: Pointer) => {
      const bytes = read.u32(buffer as never, 16);
      const pcm = bytes ? bufferData(buffer, bytes).slice() : null;
      if (pcm && hear) hear(pcm);
      else if (pcm && kept.push(pcm) > PREROLL_CHUNKS) kept.shift();
      if (running) queue.enqueue(from, buffer, 0, null);
    },
    { args: ["ptr", "ptr", "ptr", "ptr", "u32", "ptr"], returns: "void" },
  );
  let input: bigint | null = null;
  const buffers: bigint[] = [];
  const open = (): void => {
    if (running) return;
    if (input === null) {
      input = made(queue.input(pcmFormat(), onInput.ptr, null, mainLoop, commonModes, 0, out), "opening the microphone");
      for (let i = 0; i < 16; i++) buffers.push(made(queue.allocate(input, CHUNK_BYTES, out), "a microphone buffer"));
    }
    running = true;
    for (const buffer of buffers) queue.enqueue(input, buffer, 0, null);
    made(queue.start(input, null), "starting the microphone");
  };
  const mic = {
    warm: open,
    /** Hand over what is remembered, then everything as it comes. */
    listen(onChunk: (pcm: Uint8Array) => void): void {
      open();
      for (const pcm of kept.splice(0)) onChunk(pcm);
      hear = onChunk;
    },
    /** Stop handing over: a warm microphone goes back to remembering, a cold one is closed. */
    rest(keepWarm: boolean): void {
      hear = null;
      if (keepWarm || !running || input === null) return;
      running = false;
      queue.stop(input, true);
      kept.length = 0;
    },
  };

  // The speaker: an AVAudioPlayerNode, which is "queue the audio for playback in order" as an object. What is scheduled
  // on it plays after what was scheduled before, or at once if nothing is left, on the system's audio thread and not this
  // one. It is opened once and left running: a speaker started for each sentence costs that sentence half a second.
  let engine: unknown = null;
  let player: unknown = null;
  let format: unknown = null;
  let until = 0; // when what is queued will have been played, by this process's clock (within 30 ms of the node's own, measured)
  const schedule = (samples: Float32Array): void => {
    if (!samples.length) return;
    const buffer = call(call(cls("AVAudioPCMBuffer"), "alloc", "ptr"), "initWithPCMFormat:frameCapacity:", "ptr,ptr,u32", format, samples.length);
    call(buffer, "setFrameLength:", "void,u32", samples.length);
    new Float32Array(toArrayBuffer(read.ptr(call(buffer, "floatChannelData", "ptr") as never, 0) as never, 0, samples.length * 4)).set(samples);
    call(player, "scheduleBuffer:completionHandler:", "void,ptr,ptr", buffer, null);
    call(buffer, "release"); // the node keeps it until it has been played
    until = Math.max(until, performance.now()) + samples.length / (SAMPLE_RATE / 1000);
  };
  /** The engine running and the node playing. An engine stops itself when the output device changes, so a stopped one is left for a new one, which finds the new device. */
  const awake = (): boolean => {
    const drop = (...objects: unknown[]) => objects.forEach((object) => call(object, "release"));
    if (engine && !call(engine, "isRunning", "bool")) engine = (drop(player, engine), null);
    if (!engine) {
      macos.objc.load("/System/Library/Frameworks/AVFAudio.framework/AVFAudio");
      const make = (name: string) => call(call(cls(name), "alloc", "ptr"), "init", "ptr");
      const [made, node] = [make("AVAudioEngine"), make("AVAudioPlayerNode")];
      format ??= call(call(cls("AVAudioFormat"), "alloc", "ptr"), "initWithCommonFormat:sampleRate:channels:interleaved:", "ptr,u64,f64,u32,bool", 1, SAMPLE_RATE, 1, false); // float32: the mixer takes nothing else
      call(made, "attachNode:", "void,ptr", node);
      call(made, "connect:to:format:", "void,ptr,ptr,ptr", node, call(made, "mainMixerNode", "ptr"), format);
      if (!call(made, "startAndReturnError:", "bool,ptr", null)) return drop(node, made), false; // nothing to play on: the next chunk tries again
      [engine, player] = [made, node];
    }
    if (call(player, "isPlaying", "bool")) return true;
    call(player, "play"); // the first chunk, or the first since a hush: a node told to play on a stopped engine raises, which is why this comes last
    until = 0;
    return true;
  };
  const speaker = {
    /**
     * Queue a chunk. gpt-live-1 sends its audio a tenth of a second at a time, as fast as it is spoken and no faster, with
     * a stall now and then that it never makes up (measured). Played from an empty queue, every late chunk is a gap, heard
     * as crackle, so the queue is kept a cushion ahead of the speaker, with silence: restored in the voice's pauses, where
     * more silence cannot be heard, and in the middle of a word only when the queue is all but empty.
     */
    play(pcm: Uint8Array): void {
      pooled(() => {
        if (!awake()) return;
        const [samples, view] = [new Float32Array(pcm.length >> 1), new DataView(pcm.buffer, pcm.byteOffset)];
        let peak = 0;
        for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs((samples[i] = view.getInt16(i * 2, true) / 32768)));
        const left = Math.max(0, until - performance.now());
        const pad = cushion(left, peak < QUIET);
        if (process.env.HANDS_DEBUG && pad !== 0 && (pad === null || peak >= QUIET)) console.error(`[speaker] ${Math.round(left)} ms queued: ${pad === null ? "a pause left out" : `${Math.round(pad)} ms of silence put into speech`}`);
        if (pad === null) return;
        schedule(new Float32Array(Math.round((pad * SAMPLE_RATE) / 1000)));
        schedule(samples);
      });
    },
    /** Drop what is queued: the user has started talking over it. */
    hush(): void {
      if (player) pooled(() => call(player, "stop")); // and `play` starts it again
      until = 0;
    },
  };
  return { mic, speaker };
}

// ------------------------------------------------------------------ the panel

/**
 * A borderless panel in the bottom right corner that shows one web page, above other windows, without ever
 * making this process the app in front. A borderless window refuses the keyboard, and the page has a box to type
 * in, so the panel is a subclass, made here at run time, whose only difference is that it says yes. So is its web view.
 */
function panel(url: string) {
  macos.objc.load("/System/Library/Frameworks/WebKit.framework/WebKit");
  const yes = new JSCallback(() => true, { args: ["ptr", "ptr"], returns: "bool" });
  const saying = (parent: string, name: string, selector: string, types: string) => {
    const made = fn("objc_allocateClassPair", ["ptr", "cstring", "u64"], "ptr")(cls(parent), Buffer.from(`${name}\0`), 0);
    fn("class_addMethod", ["ptr", "ptr", "ptr", "cstring"], "bool")(made, sel(selector), yes.ptr, Buffer.from(`${types}\0`));
    fn("objc_registerClassPair", ["ptr"], "void")(made);
    return made;
  };
  const keyable = saying("NSPanel", "HandsPanel", "canBecomeKeyWindow", "B@:");
  // And a view in a window that is not key swallows the first click, to make the window key: a card would need two. This one takes it.
  const clickable = saying("WKWebView", "HandsWebView", "acceptsFirstMouse:", "B@:@");

  const window = call(call(keyable, "alloc", "ptr"), "initWithContentRect:styleMask:backing:defer:", "ptr,f64,f64,f64,f64,u64,u64,bool", 0, 0, 10, 10, 1 << 7, 2, false); // non-activating
  for (const [selector, value] of [["setOpaque:", false], ["setHasShadow:", false], ["setReleasedWhenClosed:", false], ["setHidesOnDeactivate:", false]] as const) call(window, selector, "void,bool", value); // prettier-ignore
  call(window, "setBackgroundColor:", "void,ptr", call(cls("NSColor"), "clearColor", "ptr"));
  call(window, "setLevel:", "void,i64", 3); // floating: over ordinary windows, under menus
  call(window, "setCollectionBehavior:", "void,u64", 1 | (1 << 3) | (1 << 6) | (1 << 8)); // every desktop, not in Mission Control or the window cycle, over full screen apps
  const web = call(call(clickable, "alloc", "ptr"), "initWithFrame:configuration:", "ptr,f64,f64,f64,f64,ptr", 0, 0, 10, 10, call(call(cls("WKWebViewConfiguration"), "alloc", "ptr"), "init", "ptr"));
  call(web, "setValue:forKey:", "void,ptr,ptr", call(cls("NSNumber"), "numberWithBool:", "ptr,bool", false), str("drawsBackground")); // the page's own background, which is none
  call(window, "setContentView:", "void,ptr", web);
  const address = call(cls("NSURL"), "URLWithString:", "ptr,ptr", call(cls("NSString"), "stringWithUTF8String:", "ptr,cstring", Buffer.from(`${url}\0`)));
  call(web, "loadRequest:", "ptr,ptr", call(cls("NSURLRequest"), "requestWithURL:", "ptr,ptr", address));

  let shown = false;
  return {
    /** Size the panel to the page's content and keep it in the corner, clear of the Dock. Nothing to show: no panel. */
    fit(width: number, height: number): void {
      pooled(() => {
        if (width < 1 || height < 1) {
          if (shown) call(window, "orderOut:", "void,ptr", null);
          return void (shown = false);
        }
        const screen = call(call(cls("NSScreen"), "screens", "ptr"), "objectAtIndex:", "ptr,u64", 0);
        const [left, bottom, wide] = structOf(screen, "visibleFrame", 4) as [number, number, number, number]; // Cocoa's own coordinates, y up
        call(window, "setFrame:display:", "void,f64,f64,f64,f64,bool", left + wide - width - MARGIN_PT, bottom + MARGIN_PT, width, height, true);
        if (!shown) call(window, "orderFrontRegardless");
        shown = true;
      });
    },
    /** How tall the panel may grow: the main screen, less the menu bar, the Dock and the margins. */
    room(): number {
      return pooled(() => (structOf(call(call(cls("NSScreen"), "screens", "ptr"), "objectAtIndex:", "ptr,u64", 0), "visibleFrame", 4)[3] ?? 800) - 2 * MARGIN_PT);
    },
    /** Give the page the keyboard, or hand it back to whatever the user was in. */
    focus(on: boolean): void {
      pooled(() => {
        if (on) return void call(window, "makeKeyWindow");
        if (!shown || !call(window, "isKeyWindow", "bool")) return;
        call(window, "orderOut:", "void,ptr", null); // a key window that leaves gives the key back
        call(window, "orderFrontRegardless");
      });
    },
  };
}

// ------------------------------------------------------------------ the camera

/**
 * One window of another app as a small JPEG, wherever it lies and whatever covers it. SkyLight's capture is what
 * window switchers use: a few milliseconds, no file, no prompt. Null when it is not there, or the window is gone.
 */
function camera(): (windowId: number) => Uint8Array | null {
  macos.objc.load("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight");
  let capture: ReturnType<typeof fn>;
  try {
    capture = fn("SLSHWCaptureWindowList", ["u32", "ptr", "u32", "u32"], "ptr");
  } catch {
    return () => null;
  }
  const connection = fn("CGSMainConnectionID", [], "u32")();
  const [count, item, release] = [fn("CFArrayGetCount", ["ptr"], "i64"), fn("CFArrayGetValueAtIndex", ["ptr", "i64"], "ptr"), fn("CFRelease", ["ptr"], "void")];
  const [widthOf, heightOf] = [fn("CGImageGetWidth", ["ptr"], "u64"), fn("CGImageGetHeight", ["ptr"], "u64")];
  const space = fn("CGColorSpaceCreateDeviceRGB", [], "ptr")();
  const [bitmap, draw, snapshot] = [
    fn("CGBitmapContextCreate", ["ptr", "u64", "u64", "u64", "u64", "ptr", "u32"], "ptr"),
    fn("CGContextDrawImage", ["ptr", "f64", "f64", "f64", "f64", "ptr"], "void"),
    fn("CGBitmapContextCreateImage", ["ptr"], "ptr"),
  ];
  const [dataCreate, destination, add, finalize, bytesOf, lengthOf] = [
    fn("CFDataCreateMutable", ["ptr", "i64"], "ptr"),
    fn("CGImageDestinationCreateWithData", ["ptr", "ptr", "u64", "ptr"], "ptr"),
    fn("CGImageDestinationAddImage", ["ptr", "ptr", "ptr"], "void"),
    fn("CGImageDestinationFinalize", ["ptr"], "bool"),
    fn("CFDataGetBytePtr", ["ptr"], "ptr"),
    fn("CFDataGetLength", ["ptr"], "i64"),
  ];
  return (windowId) => {
    const list = capture(connection, new Uint32Array([windowId]), 1, (1 << 11) | (1 << 9)); // ignore the clip shape, nominal resolution
    if (!list) return null;
    const owned: unknown[] = [list];
    try {
      if (Number(count(list)) < 1) return null;
      const full = item(list, 0);
      const [width, height] = [Number(widthOf(full)), Number(heightOf(full))];
      const scale = Math.min(1, THUMB_PX / width);
      const [w, h] = [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
      const context = bitmap(null, w, h, 8, w * 4, space, 5); // RGBX: a JPEG has no alpha to keep
      owned.push(context);
      draw(context, 0, 0, w, h, full);
      const small = snapshot(context);
      const data = dataCreate(null, 0);
      const jpeg = destination(data, str("public.jpeg"), 1, null);
      owned.push(small, data, jpeg);
      add(jpeg, small, null);
      if (!finalize(jpeg)) return null;
      return new Uint8Array(toArrayBuffer(bytesOf(data), 0, Number(lengthOf(data)))).slice();
    } finally {
      for (const ref of owned) if (ref) release(ref);
    }
  };
}

// ------------------------------------------------------------------ all of it

export interface Shell {
  mic: ReturnType<typeof sound>["mic"];
  speaker: ReturnType<typeof sound>["speaker"];
  panel: ReturnType<typeof panel>;
  thumbnail: ReturnType<typeof camera>;
  /** Hold the talk key down from inside: a run that speaks from a file has no finger. */
  holdKey(down: boolean): void;
  /** The ordinary window in front of all others, the one the user is looking at. */
  frontWindow(): number | null;
}

export function start(options: { url: string; onTalk: (talk: Talk) => void }): Shell {
  const key = watchKey(options.onTalk);
  const parts = pooled(() => {
    app = call(cls("NSApplication"), "sharedApplication", "ptr");
    call(app, "setActivationPolicy:", "bool,i64", 1); // accessory: no Dock icon, never the app in front
    return { ...sound(), panel: panel(options.url), thumbnail: camera() };
  });
  const runLoop = fn("CFRunLoopRunInMode", ["ptr", "f64", "bool"], "i32");
  setInterval(() => {
    pooled(() => {
      for (let i = 0; i < 40 && runLoop(mode(), 0, true) === 4; i++); // 4: a source was handled, and there may be another
      for (let event; (event = call(app, "nextEventMatchingMask:untilDate:inMode:dequeue:", "ptr,u64,ptr,ptr,bool", 0xffffffffffffffffn, null, mode(), true)); ) call(app, "sendEvent:", "void,ptr", event);
    });
    key.poll();
  }, PUMP_MS);
  return { ...parts, holdKey: key.fake, frontWindow: () => macos.allWindows().find((w) => w.alpha >= 1)?.id ?? null };
}
