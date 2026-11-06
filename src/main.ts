import { device } from "@shared/device";
import { loadValues, str, num, bool } from "@shared/settings";
import { FONTS, type PixelFont } from "./fonts";
import manifest from "./appmeta/manifest.json";
import type { DisplayDrawParams } from "@busy-app/busy-lib";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

type Element = NonNullable<DisplayDrawParams["elements"]>[number];

const SCREEN_W = 72;
const SCREEN_H = 16;
/** Pixels between glyphs. */
const GAP = 1;
/** Width of the colon column, including the gap on each side. */
const COLON_W = 3;
/** How long a toast (font name, style name) stays on screen. */
const TOAST_SECONDS = 2;

/** Gradient stops, top to bottom, per colour style. */
const STYLES: Record<string, { label: string; stops: string[] }> = {
  crawl: { label: "CRAWL", stops: ["#FFF3A0", "#FFE81F", "#D9A400"] },
  saber_blue: { label: "SABER", stops: ["#B6ECFF", "#2E8BFF", "#0040B8"] },
  sith_red: { label: "SITH", stops: ["#FF8A8A", "#E80000", "#7A0000"] },
  hologram: { label: "HOLO", stops: ["#D8FFFF", "#3FD6E0", "#0C6E7C"] },
  white: { label: "WHITE", stops: ["#FFFFFF", "#FFFFFF"] },
};
const STYLE_ORDER = Object.keys(STYLES);

interface Settings {
  font: string;
  cycleMinutes: number;
  style: string;
  hour24: boolean;
  blinkColon: boolean;
}

interface State {
  settings: Settings;
  /** Index into FONTS of the typeface currently shown. */
  fontIndex: number;
  /** Whether the typeface advances on its own every cycleMinutes. */
  cycling: boolean;
  /** Minute-of-epoch when the typeface last changed, for the cycle timer. */
  lastSwitchMinute: number;
  styleIndex: number;
  /** Colon phase when blinking. */
  colonOn: boolean;
  /** Set once the app is quitting; ignores late timers and input. */
  stopped: boolean;
  /** One draw in flight at a time; a redraw requested meanwhile runs after it. */
  drawing: boolean;
  redrawWanted: boolean;
}

/* ---------- colour helpers ---------- */

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** The gradient sampled at `rows` evenly spaced points, top to bottom. */
function gradient(stops: string[], rows: number): string[] {
  if (stops.length === 1) return Array.from({ length: rows }, () => stops[0]!);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const t = rows === 1 ? 0 : i / (rows - 1);
    const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    const local = t * (stops.length - 1) - seg;
    const a = hexToRgb(stops[seg]!);
    const b = hexToRgb(stops[seg + 1]!);
    out.push(rgbToHex(a[0] + (b[0] - a[0]) * local, a[1] + (b[1] - a[1]) * local, a[2] + (b[2] - a[2]) * local));
  }
  return out;
}

/* ---------- bitmap composition ---------- */

/** Palette letters for the gradient rows; "." stays transparent. */
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** Renders `text` (digits and ":") in `font` as one XPM2 bitmap coloured by the style gradient. */
function composeXpm(font: PixelFont, text: string, stops: string[], colonOn: boolean): { data: string; width: number } {
  const h = font.height;
  const parts: { rows: readonly string[]; width: number }[] = [];
  for (const ch of text) {
    if (ch === ":") {
      parts.push({ rows: colonRows(h, colonOn), width: COLON_W });
    } else {
      const rows = font.glyphs[ch];
      if (rows) parts.push({ rows, width: rows[0]!.length });
    }
  }
  let width = 0;
  for (let i = 0; i < parts.length; i++) width += parts[i]!.width + (i > 0 ? GAP : 0);
  width = Math.max(1, Math.min(SCREEN_W, width));

  const colours = gradient(stops, h);
  const lines: string[] = ["! XPM2", `${width} ${h} ${h + 1} 1`, ". c none"];
  for (let i = 0; i < h; i++) lines.push(`${LETTERS[i]} c ${colours[i]}`);
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) row += ".".repeat(GAP);
      const src = parts[i]!.rows[y] ?? "";
      let seg = "";
      for (let x = 0; x < parts[i]!.width; x++) seg += src[x] === "#" ? LETTERS[y] : ".";
      row += seg;
    }
    lines.push(row.slice(0, width).padEnd(width, "."));
  }
  return { data: lines.join("\n"), width };
}

/** Two 1x2 dots in a 3-wide column, or an empty column while the colon is off. */
function colonRows(h: number, on: boolean): string[] {
  const rows: string[] = [];
  const top = Math.max(0, Math.round(h * 0.3) - 1);
  const bottom = Math.min(h - 2, Math.round(h * 0.7) - 1);
  for (let y = 0; y < h; y++) {
    const dot = on && (y === top || y === top + 1 || y === bottom || y === bottom + 1);
    rows.push(dot ? ".#." : "...");
  }
  return rows;
}

/* ---------- frame ---------- */

/** "H:MM" on the 12-hour clock (no marker: it is obvious which half of the day it is), "HH:MM" on the 24-hour one. */
function timeText(d: Date, hour24: boolean): string {
  const m = String(d.getMinutes()).padStart(2, "0");
  let h = d.getHours();
  if (hour24) return `${String(h).padStart(2, "0")}:${m}`;
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m}`;
}

/** The one element of a frame: the time bitmap, centred. */
function frame(state: State, now: Date): Element[] {
  const font = FONTS[state.fontIndex]!;
  const style = STYLES[state.settings.style] ?? STYLES.crawl!;
  const { data, width } = composeXpm(font, timeText(now, state.settings.hour24), style.stops, state.settings.blinkColon ? state.colonOn : true);
  const x = Math.max(0, Math.floor((SCREEN_W - width) / 2));
  const y = Math.floor((SCREEN_H - font.height) / 2);
  return [{ id: "time", type: "xpmbitmap", x, y, align: "top_left", data }];
}

/** A short label over a black panel; both expire on the device after TOAST_SECONDS. */
function toast(text: string): Element[] {
  return [
    {
      id: "toast_bg",
      type: "rectangle",
      x: 0,
      y: 0,
      align: "top_left",
      width: SCREEN_W,
      height: SCREEN_H,
      fill: "solid",
      fill_colors: ["#000000FF"],
      border_width: 0,
      z_index: 10,
      timeout: TOAST_SECONDS,
    },
    {
      id: "toast",
      type: "text",
      x: SCREEN_W / 2,
      y: SCREEN_H / 2,
      align: "center",
      text,
      font: "small",
      color: "#FFFFFFFF",
      z_index: 11,
      timeout: TOAST_SECONDS,
    },
  ];
}

/* ---------- app ---------- */

function fontLabel(font: PixelFont): string {
  return font.name.replace(/-/g, " ").toUpperCase();
}

function report(err: unknown): void {
  console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);
}

function main(): void {
  const state: State = {
    settings: { font: "cycle", cycleMinutes: 5, style: "crawl", hour24: false, blinkColon: false },
    fontIndex: 0,
    cycling: true,
    lastSwitchMinute: Math.floor(Date.now() / 60000),
    styleIndex: 0,
    colonOn: true,
    stopped: false,
    drawing: false,
    redrawWanted: false,
  };

  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Draws the current frame, coalescing requests that arrive while one is in flight. */
  async function draw(extra: Element[] = []): Promise<void> {
    if (state.stopped) return;
    if (state.drawing) {
      state.redrawWanted = true;
      return;
    }
    state.drawing = true;
    try {
      await device.DisplayDraw({ application_name: APP, priority: 50, elements: frame(state, new Date()).concat(extra) });
    } finally {
      state.drawing = false;
      if (state.redrawWanted && !state.stopped) {
        state.redrawWanted = false;
        void draw().catch(report);
      }
    }
  }

  function advanceFont(step: number): void {
    state.fontIndex = (state.fontIndex + step + FONTS.length) % FONTS.length;
    state.lastSwitchMinute = Math.floor(Date.now() / 60000);
  }

  /** Runs on every tick: once a second when the colon blinks, otherwise on the minute. */
  function tick(): void {
    if (state.stopped) return;
    const now = new Date();
    if (state.cycling && Math.floor(now.getTime() / 60000) - state.lastSwitchMinute >= state.settings.cycleMinutes) {
      advanceFont(1);
    }
    state.colonOn = !state.colonOn;
    void draw().catch(report);
    schedule();
  }

  /** Arms the next tick, aligned to the second or to the minute. */
  function schedule(): void {
    if (state.stopped) return;
    const ms = Date.now();
    const period = state.settings.blinkColon ? 1000 : 60000;
    const delay = period - (ms % period) + 20;
    timer = setTimeout(tick, delay);
  }

  function stop(unbind: () => void): void {
    state.stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    // The unbind is the last handle: schedule it so this callback returns first.
    setTimeout(unbind, 0);
  }

  const unbind = listen("input", (event) => {
    if (state.stopped) return;
    if (event.key === "back" && event.action === "short") {
      stop(unbind);
      return;
    }
    if (event.key === "encoder") {
      // Turning the wheel picks a typeface by hand and pauses cycling until OK is pressed.
      advanceFont(event.delta);
      state.cycling = false;
      void draw(toast(fontLabel(FONTS[state.fontIndex]!))).catch(report);
      return;
    }
    if (event.key === "ok" && event.action === "short") {
      state.cycling = !state.cycling;
      state.lastSwitchMinute = Math.floor(Date.now() / 60000);
      void draw(toast(state.cycling ? "CYCLE ON" : "CYCLE OFF")).catch(report);
      return;
    }
    if (event.key === "start" && event.action === "short") {
      state.styleIndex = (state.styleIndex + 1) % STYLE_ORDER.length;
      state.settings.style = STYLE_ORDER[state.styleIndex]!;
      void draw(toast(STYLES[state.settings.style]!.label)).catch(report);
    }
  });

  // Settings are read once at launch; the first frame waits for them so the chosen typeface shows immediately.
  void loadValues(APP)
    .then((values) => {
      const s = state.settings;
      s.font = str(values, "font", s.font);
      s.cycleMinutes = Math.max(1, num(values, "cycle_minutes", s.cycleMinutes));
      s.style = str(values, "style", s.style);
      s.hour24 = bool(values, "hour_24", s.hour24);
      s.blinkColon = bool(values, "blink_colon", s.blinkColon);

      const chosen = FONTS.findIndex((f) => f.name === s.font);
      state.cycling = chosen < 0;
      state.fontIndex = chosen < 0 ? 0 : chosen;
      state.styleIndex = Math.max(0, STYLE_ORDER.indexOf(s.style));
      if (!STYLES[s.style]) s.style = "crawl";
    })
    .catch(report)
    .then(() => {
      void draw().catch(report);
      schedule();
    });
}

main();
