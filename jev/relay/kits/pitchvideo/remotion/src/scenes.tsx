// scenes.tsx — the closed set of scene templates. Generic pitch-video building blocks: what they say is the script's.
import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import type { Scene, Template } from "../../script";
import { Headline, Icon, Mark, Panel, Tile } from "./parts";
import { C, GRADIENT, MONO, enter, fit, rise } from "./theme";

type Props = { scene: Scene; title: string; frames: number };
const gradientText: React.CSSProperties = { background: GRADIENT, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" };
const leading = (value: string) => { const m = /(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?/.exec(value.replace(/,/g, "")); return m ? { n: Number(m[1]), of: m[2] ? Number(m[2]) : /%/.test(value) ? 100 : undefined } : null; };

/** A small window drawn in outline: a title bar and rows. Used wherever a desktop is pictured. */
const Win: React.FC<{ w: number; h: number; rows?: number; tone?: string; fill?: number; style?: React.CSSProperties; children?: React.ReactNode }> = ({ w, h, rows = 4, tone = C.panelEdge, fill = 1, style, children }) => (
  <div style={{ width: w, height: h, borderRadius: 16, border: `1.5px solid ${tone}`, background: "rgba(10,16,38,0.92)", overflow: "hidden", position: "relative", ...style }}>
    <div style={{ height: 30, background: "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", gap: 7, paddingLeft: 14 }}>{[C.red, C.amber, C.green].map((c) => <div key={c} style={{ width: 9, height: 9, borderRadius: 9, background: c, opacity: 0.7 }} />)}</div>
    <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
      {Array.from({ length: rows }, (_, i) => <div key={i} style={{ height: 10, borderRadius: 10, width: `${Math.max(0, Math.min(1, fill * rows - i)) * (92 - ((i * 37) % 45))}%`, background: "rgba(255,255,255,0.13)" }} />)}
    </div>
    {children}
  </div>
);

const Title: React.FC<Props> = ({ scene, title }) => {
  const frame = useCurrentFrame();
  const spots = [[-700, -210, 0], [640, -250, 8], [-760, 170, 16], [700, 150, 24]] as const;
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", position: "relative" }}>
      {spots.map(([x, y, at], i) => (
        <div key={i} style={{ position: "absolute", left: "50%", top: "50%", translate: `${x - 120}px ${y - 80 + Math.sin((frame + i * 40) / 38) * 10}px`, opacity: enter(frame, at + 10, 24) * 0.75 }}>
          <Win w={250} h={160} rows={3} tone={i % 2 ? `${C.green}88` : `${C.blue}88`} fill={interpolate(frame, [at + 20, at + 120], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} />
          <div style={{ position: "absolute", left: 60 + ((frame * 1.3 + i * 50) % 130), top: 70 + Math.sin((frame + i * 25) / 14) * 26 }}><svg width={26} height={26} viewBox="0 0 24 24" fill={C.text}><path d="M5 3l14 7-6 2-2 6z" /></svg></div>
        </div>
      ))}
      <div style={{ scale: String(interpolate(enter(frame, 2, 26), [0, 1], [0.7, 1])), opacity: enter(frame, 2, 18) }}><Mark size={132} /></div>
      <div style={{ fontSize: fit(title, 190, 8), fontWeight: 800, letterSpacing: -5, lineHeight: 1, marginTop: 30, ...gradientText, ...rise(frame, 10, 50) }}>{title}</div>
      <div style={{ fontSize: fit(scene.headline, 58, 46), fontWeight: 700, marginTop: 26, textAlign: "center", maxWidth: 1120, lineHeight: 1.12, ...rise(frame, 22) }}>{scene.headline}</div>
      <div style={{ fontSize: fit(scene.sub ?? "", 36, 80), color: C.muted, marginTop: 18, textAlign: "center", maxWidth: 1400, lineHeight: 1.35, ...rise(frame, 32) }}>{scene.sub}</div>
    </div>
  );
};

const Problem: React.FC<Props> = ({ scene }) => {
  const frame = useCurrentFrame(), pains = scene.pains ?? [];
  return (
    <>
      <Headline text={scene.headline} />
      <div style={{ flex: 1, display: "flex", gap: 36, marginTop: 40, alignItems: "stretch", maxHeight: 470, marginBottom: "auto" }}>
        {pains.map((p, i) => (
          <Panel key={i} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 22, borderColor: `${C.red}44`, ...rise(frame, 16 + i * 12, 60) }}>
            <Tile icon={p.icon ?? "clock"} tone={i % 2 ? C.amber : C.red} />
            <div style={{ fontSize: fit(p.title, 46, 30), fontWeight: 750, lineHeight: 1.15 }}>{p.title}</div>
            <div style={{ fontSize: fit(p.detail, 32, 110), color: C.muted, lineHeight: 1.4 }}>{p.detail}</div>
            <div style={{ marginTop: "auto", height: 6, borderRadius: 6, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}><div style={{ height: 6, width: `${enter(frame, 30 + i * 12, 50) * 100}%`, background: i % 2 ? C.amber : C.red }} /></div>
          </Panel>
        ))}
      </div>
    </>
  );
};

const Stat: React.FC<Props> = ({ scene }) => {
  const frame = useCurrentFrame(), stat = scene.stat ?? { value: "", label: "", scope: "" }, parsed = leading(stat.value);
  const share = parsed?.of ? Math.max(0, Math.min(1, parsed.n / parsed.of)) : null, R = 250, around = 2 * Math.PI * R;
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 90 }}>
      <div style={{ width: 600, height: 600, position: "relative", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width={600} height={600} style={{ position: "absolute", rotate: "-90deg" }}>
          <defs><linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={C.blue} /><stop offset="1" stopColor={C.green} /></linearGradient></defs>
          <circle cx={300} cy={300} r={R} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={26} />
          <circle cx={300} cy={300} r={R} fill="none" stroke="url(#ring)" strokeWidth={26} strokeLinecap="round" strokeDasharray={around} strokeDashoffset={around * (1 - (share ?? 1) * enter(frame, 10, 40))} />
          {share === null ? <circle cx={300} cy={300} r={R - 44} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={2} strokeDasharray="4 14" /> : null}
        </svg>
        <div style={{ fontSize: fit(stat.value, 190, 4.2, 0.4), fontWeight: 850, letterSpacing: -6, ...gradientText, scale: String(interpolate(enter(frame, 8, 24), [0, 1], [0.6, 1])), opacity: enter(frame, 8, 14) }}>{stat.value}</div>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 28 }}>
        <Headline text={scene.headline} size={64} />
        <div style={{ fontSize: fit(stat.label, 44, 70), fontWeight: 600, lineHeight: 1.25, ...rise(frame, 20) }}>{stat.label}</div>
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", ...rise(frame, 32) }}>
          <div style={{ marginTop: 4 }}><Icon name="chart" size={34} color={C.green} /></div>
          <div style={{ fontSize: fit(stat.scope, 30, 120), color: C.muted, lineHeight: 1.4 }}>{stat.scope}</div>
        </div>
      </div>
    </div>
  );
};

const Compare: React.FC<Props> = ({ scene }) => {
  const frame = useCurrentFrame(), a = scene.before ?? { value: "", label: "" }, b = scene.after ?? { value: "", label: "" }, pa = leading(a.value), pb = leading(b.value);
  const top = pa && pb ? Math.max(pa.of ?? 0, pb.of ?? 0, pa.n, pb.n) : 0;
  const side = (s: { value: string; label: string }, parsed: ReturnType<typeof leading>, tone: string, at: number, word: string) => (
    <Panel style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14, borderColor: `${tone}55`, ...rise(frame, at, 60) }}>
      <div style={{ fontFamily: MONO, fontSize: 24, letterSpacing: 4, color: tone, textTransform: "uppercase" }}>{word}</div>
      <div style={{ fontSize: fit(s.value, 150, 5, 0.45), fontWeight: 850, letterSpacing: -4, lineHeight: 1.05, color: tone === C.green ? undefined : C.text, ...(tone === C.green ? gradientText : {}) }}>{s.value}</div>
      <div style={{ fontSize: fit(s.label, 32, 90), color: C.muted, lineHeight: 1.35, minHeight: 88 }}>{s.label}</div>
      {top ? <div style={{ marginTop: "auto", height: 18, borderRadius: 18, background: "rgba(255,255,255,0.07)", overflow: "hidden" }}><div style={{ height: 18, borderRadius: 18, width: `${((parsed?.n ?? 0) / top) * 100 * enter(frame, at + 14, 40)}%`, background: tone === C.green ? GRADIENT : tone }} /></div> : null}
    </Panel>
  );
  return (
    <>
      <Headline text={scene.headline} size={66} />
      <div style={{ fontSize: fit(scene.metric ?? "", 32, 100), color: C.muted, marginTop: 14, ...rise(frame, 10) }}>{scene.metric}</div>
      <div style={{ flex: 1, display: "flex", gap: 30, marginTop: 34, alignItems: "stretch" }}>
        {side(a, pa, C.red, 16, "before")}
        <div style={{ display: "flex", alignItems: "center", opacity: enter(frame, 34, 14), translate: `${(1 - enter(frame, 34, 20)) * -30}px 0px` }}><svg width={90} height={60} viewBox="0 0 90 60" fill="none" stroke={C.green} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round"><path d="M6 30h74 M58 8l22 22-22 22" /></svg></div>
        {side(b, pb, C.green, 40, "after")}
      </div>
    </>
  );
};

const How: React.FC<Props> = ({ scene, frames }) => {
  const frame = useCurrentFrame(), steps = scene.steps ?? [], gap = 70, beat = Math.max(24, Math.min(60, (frames * 0.5) / steps.length));
  const active = Math.floor(Math.max(0, frame - 30) / beat) % Math.max(1, steps.length);
  return (
    <>
      <Headline text={scene.headline} size={66} />
      <div style={{ display: "flex", gap, marginTop: 40, alignItems: "stretch", minHeight: 400 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ flex: 1, position: "relative", display: "flex", ...rise(frame, 14 + i * 14, 50) }}>
            <Panel style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, padding: 32, borderColor: active === i && frame > 30 ? `${C.green}aa` : C.panelEdge, boxShadow: active === i && frame > 30 ? `0 0 28px ${C.green}33` : undefined }}>
              <Tile icon={s.icon} size={76} />
              <div style={{ fontSize: fit(s.title, 40, 22), fontWeight: 750, lineHeight: 1.15 }}>{s.title}</div>
              {s.role ? <div style={{ fontFamily: MONO, fontSize: fit(s.role, 23, 34), color: C.green, letterSpacing: 1 }}>{s.role}</div> : null}
              <div style={{ fontSize: fit(s.detail, 28, 95), color: C.muted, lineHeight: 1.38 }}>{s.detail}</div>
            </Panel>
            {i < steps.length - 1 ? <svg width={gap} height={40} viewBox={`0 0 ${gap} 40`} style={{ position: "absolute", right: -gap, top: "42%", opacity: enter(frame, 26 + i * 14, 12) }} fill="none" stroke={C.green} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round"><path d={`M8 20h${gap - 22} M${gap - 28} 8l14 12-14 12`} strokeDasharray={120} strokeDashoffset={120 * (1 - enter(frame, 26 + i * 14, 20))} /></svg> : null}
          </div>
        ))}
      </div>
      <div style={{ position: "relative", height: 6, borderRadius: 6, marginTop: 44, background: "rgba(255,255,255,0.08)", opacity: enter(frame, 30, 20) }}>
        <div style={{ position: "absolute", top: -7, left: `${(((frame - 30) % (beat * steps.length)) / (beat * steps.length)) * 100}%`, width: 120, height: 20, borderRadius: 20, translate: "-60px 0px", background: GRADIENT, filter: "blur(2px)", opacity: frame > 30 ? 0.95 : 0 }} />
        {steps.map((_, i) => <div key={i} style={{ position: "absolute", top: -6, left: `${((i + 0.5) / steps.length) * 100}%`, width: 18, height: 18, borderRadius: 18, translate: "-9px 0px", background: active === i && frame > 30 ? C.green : C.faint }} />)}
      </div>
    </>
  );
};

const List: React.FC<Props> = ({ scene }) => {
  const frame = useCurrentFrame(), items = scene.items ?? [], columns = items.length <= 3 ? items.length : items.length === 4 ? 2 : 3, five = items.length === 5;
  return (
    <>
      <Headline text={scene.headline} size={66} />
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${five ? 6 : columns}, 1fr)`, gridAutoRows: items.length <= 3 ? 360 : 250, gap: 28, marginTop: 40 }}>
        {items.map((it, i) => (
          <Panel key={i} style={{ display: "flex", gap: 26, padding: 30, alignItems: "flex-start", flexDirection: items.length <= 3 ? "column" : "row", gridColumn: five ? `span ${i < 3 ? 2 : 3}` : undefined, ...rise(frame, 14 + i * 9, 50) }}>
            <Tile icon={it.icon} size={columns === 3 ? 72 : 84} />
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: fit(it.title, columns === 3 ? 34 : 40, 28), fontWeight: 750, lineHeight: 1.15 }}>{it.title}</div>
              <div style={{ fontSize: fit(it.detail, columns === 3 ? 26 : 29, 100), color: C.muted, lineHeight: 1.36 }}>{it.detail}</div>
            </div>
          </Panel>
        ))}
      </div>
    </>
  );
};

/** The user's screen stays the user's; in its corner a preview shows a worker doing the task, action by action. */
const Demo: React.FC<Props> = ({ scene, frames, title }) => {
  const frame = useCurrentFrame(), actions = scene.actions ?? [], from = 40, until = frames * 0.78, per = (until - from) / Math.max(1, actions.length);
  const doing = Math.min(actions.length, Math.max(0, Math.floor((frame - from) / per))), done = frame >= until, tone = done ? C.green : C.blue;
  const spots = [[90, 96], [300, 150], [180, 214], [380, 270], [240, 120]] as const, here = spots[Math.min(doing, actions.length - 1) % spots.length]!, before = spots[Math.max(0, Math.min(doing, actions.length - 1) - 1) % spots.length]!;
  const t = enter(frame, from + Math.min(doing, actions.length - 1) * per, per * 0.5), cx = before[0] + (here[0] - before[0]) * t, cy = before[1] + (here[1] - before[1]) * t;
  return (
    <div style={{ flex: 1, display: "flex", gap: 40 }}>
      <div style={{ flex: 1.15, display: "flex", flexDirection: "column", gap: 20 }}>
        <Headline text={scene.headline} size={58} />
        <Panel style={{ padding: 26, display: "flex", gap: 20, alignItems: "center", ...rise(frame, 12) }}>
          <Tile icon="mic" size={64} />
          <div style={{ fontSize: fit(scene.task ?? "", 34, 60), fontWeight: 600, lineHeight: 1.3 }}>“{scene.task}”</div>
        </Panel>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {actions.map((a, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 16, opacity: 0.25 + 0.75 * enter(frame, from + i * per, 10), fontSize: fit(a, 29, 64), color: i < doing || done ? C.text : C.muted }}>
              <div style={{ width: 30, height: 30, borderRadius: 30, flexShrink: 0, border: `2px solid ${i < doing || done ? C.green : C.faint}`, background: i < doing || done ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>{i < doing || done ? <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#06122B" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg> : null}</div>
              {a}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 8, fontSize: fit(scene.result ?? "", 30, 84, 0.8), lineHeight: 1.3, fontWeight: 700, color: C.green, background: `${C.green}14`, border: `1.5px solid ${C.green}55`, borderRadius: 18, padding: "14px 22px", ...rise(frame, until, 20) }}><Icon name="check" size={36} color={C.green} />{scene.result}</div>
      </div>
      <div style={{ flex: 1, position: "relative", ...rise(frame, 8, 40) }}>
        <Win w={800} h={620} rows={9} fill={interpolate(frame, [0, frames], [0.25, 1])} style={{ position: "absolute", right: 0, top: 0, width: "100%" }}>
          <div style={{ position: "absolute", left: 18, bottom: 14, fontFamily: MONO, fontSize: 20, color: C.faint, letterSpacing: 2 }}>YOUR SCREEN</div>
        </Win>
        <div style={{ position: "absolute", right: -14, bottom: 30, width: 560, borderRadius: 22, padding: 5, background: done ? C.green : GRADIENT, boxShadow: `0 16px 36px ${tone}55`, scale: String(interpolate(enter(frame, 22, 22), [0, 1], [0.8, 1])), opacity: enter(frame, 22, 12), transformOrigin: "100% 100%" }}>
          <div style={{ borderRadius: 18, background: "#0A1026", overflow: "hidden", position: "relative", height: 330 }}>
            <div style={{ height: 40, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", background: "rgba(255,255,255,0.05)", fontFamily: MONO, fontSize: 19, color: C.muted }}>
              <span>{title.toLowerCase()} · preview</span>
              <span style={{ color: tone, display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 10, height: 10, borderRadius: 10, background: tone, opacity: done ? 1 : 0.4 + 0.6 * Math.abs(Math.sin(frame / 7)) }} />{done ? "done" : "working"}</span>
            </div>
            {[[60, 78, 330], [60, 132, 400], [60, 196, 240], [330, 252, 130]].map(([x, y, w], i) => <div key={i} style={{ position: "absolute", left: x, top: y, width: w, height: i === 3 ? 40 : 34, borderRadius: 10, border: `1.5px solid ${i < doing ? `${C.green}88` : C.panelEdge}`, background: i === 3 ? (done ? C.green : `${C.blue}55`) : "rgba(255,255,255,0.04)" }}><div style={{ margin: "12px 12px", height: 9, borderRadius: 9, width: `${i < doing ? 70 : 0}%`, background: "rgba(255,255,255,0.35)" }} /></div>)}
            <div style={{ position: "absolute", left: cx, top: cy, opacity: done ? 0 : 1 }}><svg width={30} height={30} viewBox="0 0 24 24" fill={C.text} stroke="#06122B" strokeWidth={1.2}><path d="M5 3l14 7-6 2-2 6z" /></svg></div>
          </div>
        </div>
      </div>
    </div>
  );
};

const Close: React.FC<Props> = ({ scene, title }) => {
  const frame = useCurrentFrame(), points = (scene.points ?? []).slice(0, 3);
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 24, ...rise(frame, 2) }}><Mark size={92} /><div style={{ fontSize: 96, fontWeight: 800, letterSpacing: -3, ...gradientText }}>{title}</div></div>
      <div style={{ fontSize: fit(scene.headline, 70, 40), fontWeight: 800, textAlign: "center", maxWidth: 1500, lineHeight: 1.1, ...rise(frame, 12) }}>{scene.headline}</div>
      {points.length ? <div style={{ display: "flex", gap: 20, marginTop: 6 }}>{points.map((p, i) => <div key={i} style={{ display: "flex", gap: 12, alignItems: "center", fontSize: fit(p, 28, 44), color: C.text, background: C.panel, border: `1.5px solid ${C.panelEdge}`, borderRadius: 999, padding: "14px 26px", maxWidth: 560, ...rise(frame, 24 + i * 8) }}><Icon name="check" size={28} color={C.green} />{p}</div>)}</div> : null}
      <div style={{ fontSize: fit(scene.ask ?? "", 40, 70), fontWeight: 700, color: "#06122B", background: GRADIENT, borderRadius: 22, padding: "20px 44px", marginTop: 14, textAlign: "center", maxWidth: 1400, boxShadow: "0 12px 30px rgba(61,220,151,0.30)", ...rise(frame, 44) }}>{scene.ask}</div>
    </div>
  );
};

export const SCENES: Record<Template, React.FC<Props>> = { title: Title, problem: Problem, stat: Stat, compare: Compare, how: How, list: List, demo: Demo, close: Close };
