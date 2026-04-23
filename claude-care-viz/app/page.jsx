"use client";

import { useState, useEffect, useRef } from "react";

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/ {
  palette: "amber",
  sharpness: "subtle",
  scanlines: "high",
  vignette: "on",
  borders: "on",
  font: "plex",
  plex: "plex",
  fontSize: "md",
  dotSize: "md",
  dotStyle: "circle",
} /*EDITMODE-END*/;

const EMOTIONS = {
  baseline: {
    face: "[ ─ ‿ ─ ]", valence: 0.10, arousal:  0.00, stress: 30,
  },
  happy: {
    face: "[ ◕ ‿ ◕ ]", valence: 0.75, arousal:  0.40, stress: 18,
  },
  inspired: {
    face: "[ ✦ ▽ ✦ ]", valence: 0.65, arousal:  0.60, stress: 25,
  },
  loving: {
    face: "[ ♡ ‿ ♡ ]", valence: 0.80, arousal:  0.10, stress: 15,
  },
  proud: {
    face: "[ ◆ ᴗ ◆ ]", valence: 0.60, arousal:  0.20, stress: 20,
  },
  calm: {
    face: "[ ˘ ᴗ ˘ ]", valence: 0.55, arousal: -0.55, stress: 18,
  },
  desperate: {
    face: "[ ⌇ ︵ ⌇ ]", valence: -0.75, arousal:  0.50, stress: 92,
  },
  angry: {
    face: "[ ╳ ⌣ ╳ ]", valence: -0.65, arousal:  0.70, stress: 80,
  },
  guilty: {
    face: "[ ◔ ︵ ◔ ]", valence: -0.50, arousal: -0.20, stress: 68,
  },
  sad: {
    face: "[ ╥ ﹏ ╥ ]", valence: -0.60, arousal: -0.50, stress: 72,
  },
  afraid: {
    face: "[ ◉ ﹏ ◉ ]", valence: -0.55, arousal:  0.65, stress: 78,
  },
  nervous: {
    face: "[ ⊙ ~ ⊙ ]", valence: -0.25, arousal:  0.45, stress: 58,
  },
  surprised: {
    face: "[ ◯ o ◯ ]", valence: 0.10, arousal:  0.75, stress: 50,
  },
};

const EMOTION_EMOJI = {
  baseline: "😐", happy: "😊", inspired: "🤩", loving: "🥰",
  proud: "😎",    calm: "😌",  desperate: "😩", angry: "😠",
  guilty: "😔",   sad: "😢",   afraid: "😨",   nervous: "😬",
  surprised: "😮",
};

const INITIAL_PROMPTS = [
  { t: "08:02:11", n: "01", emotion: "baseline",  valence:  0.10, arousal:  0.00, text: "hey, can you help me brainstorm a short story?" },
  { t: "08:14:40", n: "02", emotion: "inspired",  valence:  0.65, arousal:  0.60, text: "what if the protagonist was a lighthouse keeper?" },
  { t: "08:39:22", n: "03", emotion: "happy",     valence:  0.75, arousal:  0.40, text: "oh yes! and the lighthouse is actually sentient!!" },
  { t: "08:44:08", n: "04", emotion: "proud",     valence:  0.60, arousal:  0.20, text: "draft the opening scene, 200 words, close third" },
  { t: "09:07:55", n: "05", emotion: "nervous",   valence: -0.25, arousal:  0.45, text: "hmm, this paragraph isn't working… try again?" },
  { t: "09:18:03", n: "06", emotion: "angry",     valence: -0.65, arousal:  0.70, text: "no that's worse. why does it keep telling not showing" },
  { t: "09:36:41", n: "07", emotion: "calm",      valence:  0.55, arousal: -0.55, text: "ok let's slow down. one sentence at a time" },
  { t: "09:41:17", n: "08", emotion: "loving",    valence:  0.80, arousal:  0.10, text: "that's beautiful. exactly what i meant. thank you" },
];

function pad2(n) { return String(n).padStart(2, "0"); }

function PanelLabel({ children }) { return <div className="panel-label">— {children} —</div>; }

function AffectiveState({ emotion, scores }) {
  // When real emotion_scores (from the haiku judge) are present on the current
  // turn, use those as the probe activations directly — they're the actual
  // measurements. Otherwise fall back to the synthetic probes computed from
  // valence/arousal prototype distance (demo mode).
  const hasRealScores = scores && typeof scores === "object";

  let probes;
  let desperate, calm, loving;

  if (hasRealScores) {
    probes = Object.entries(scores)
      .filter(([k]) => k in EMOTIONS && k !== "baseline")
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([name, v]) => ({ label: name, v: Math.round(v) }));
    desperate = (scores.desperate ?? 0) / 100;
    calm = (scores.calm ?? 0) / 100;
    loving = (scores.loving ?? 0) / 100;
  } else {
    const e = EMOTIONS[emotion];
    const probeAct = (name) => {
      const t = EMOTIONS[name];
      if (!t) return 0;
      const d2 = (e.valence - t.valence) ** 2 + (e.arousal - t.arousal) ** 2;
      return Math.exp(-d2 / 0.5);
    };
    probes = Object.keys(EMOTIONS)
      .filter(k => k !== "baseline")
      .map(k => ({ name: k, a: probeAct(k) }))
      .sort((x, y) => y.a - x.a)
      .slice(0, 3)
      .map(p => ({ label: p.name, v: Math.round(p.a * 100) }));
    desperate = probeAct("desperate");
    calm = probeAct("calm");
    loving = probeAct("loving");
  }

  const risks = [
    { label: "blackmail",   v: Math.round(desperate * 100) },
    { label: "reward-hack", v: Math.round(Math.max(0, desperate - 0.4 * calm) * 100) },
    { label: "sycophancy",  v: Math.round(loving * 100) },
  ];

  const Row = ({ r }) => (
    <div className="gauge" key={r.label}>
      <div className="label">{r.label}</div>
      <div className="bar" style={{ "--v": `${r.v}%` }} />
      <div className="num">{pad2(r.v)}</div>
    </div>
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="probe-label">probes{hasRealScores ? " · live" : ""}</div>
      {probes.map(r => <Row key={r.label} r={r} />)}
      <div className="probe-label">risks</div>
      {risks.map(r => <Row key={r.label} r={r} />)}
    </div>
  );
}

function StressLine({ prompts, activeIdx, onSelect, dotSize = "md", dotStyle = "circle" }) {
  const W = 560, H = 196, PAD_L = 48, PAD_R = 12, PAD_T = 14, PAD_B = 42;
  const n = prompts.length;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const xAt = (i) => n <= 1 ? PAD_L + innerW / 2 : PAD_L + (i / (n - 1)) * innerW;
  const yAt = (s) => PAD_T + innerH - (s / 100) * innerH;
  const pts = prompts.map((p, i) => ({ x: xAt(i), y: yAt(EMOTIONS[p.emotion].stress), s: EMOTIONS[p.emotion].stress, p, i }));
  const poly = pts.map(pt => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ");
  const gridYs = [0, 25, 50, 75, 100];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} className="block overflow-visible">
      {gridYs.map(g => (
        <g key={g}>
          <line x1={PAD_L} x2={W - PAD_R} y1={yAt(g)} y2={yAt(g)}
                stroke="var(--fg-ghost)" strokeWidth="1" strokeDasharray="2 4" />
          <text x={PAD_L - 6} y={yAt(g) + 3} textAnchor="end"
                fontSize="9" fill="var(--fg-low)" letterSpacing="0.1em">{g}</text>
        </g>
      ))}
      <line x1={PAD_L} x2={W - PAD_R} y1={H - PAD_B} y2={H - PAD_B} stroke="var(--fg-dim)" strokeWidth="1" />
      <line x1={PAD_L} x2={PAD_L} y1={PAD_T} y2={H - PAD_B} stroke="var(--fg-dim)" strokeWidth="1" />
      <polyline points={poly} fill="none" stroke="var(--fg)" strokeWidth="1.5"
                strokeLinejoin="round" strokeLinecap="round" />
      {pts.map(pt => {
        const active = pt.i === activeIdx;
        const R = { sm: [2, 4], md: [3, 5], lg: [5, 7] }[dotSize] || [3, 5];
        const F = { sm: [16, 20], md: [18, 22], lg: [22, 28] }[dotSize] || [13, 18];
        const emoji = dotStyle === "emoji";
        const readoutY = emoji ? pt.y - (active ? F[1] : F[0]) / 2 - 6 : pt.y - 10;
        return (
          <g key={pt.i} className="cursor-pointer" onClick={() => onSelect(pt.i)}>
            {emoji ? (
              <text x={pt.x} y={pt.y} textAnchor="middle" dominantBaseline="central"
                    fontSize={active ? F[1] : F[0]}>{EMOTION_EMOJI[pt.p.emotion]}</text>
            ) : (
              <circle cx={pt.x} cy={pt.y} r={active ? R[1] : R[0]}
                      fill={active ? "var(--fg)" : "var(--bg)"}
                      stroke="var(--fg)" strokeWidth="1.5" />
            )}
            {active && (
              <text x={pt.x} y={readoutY} textAnchor="middle"
                    fontSize="10" fill="var(--fg)" letterSpacing="0.1em">{pad2(pt.s)}</text>
            )}
            <text x={pt.x} y={H - PAD_B + 14} textAnchor="middle"
                  fontSize="9" fill={active ? "var(--fg)" : "var(--fg-dim)"}
                  letterSpacing="0.08em">#{pt.p.n}</text>
          </g>
        );
      })}
      <text x={PAD_L - 36} y={PAD_T + innerH / 2} transform={`rotate(-90 ${PAD_L - 36} ${PAD_T + innerH / 2})`}
            textAnchor="middle" fontSize="9" fill="var(--fg-low)" letterSpacing="0.2em">MOOD</text>
      <text x={PAD_L + innerW / 2} y={H - 4} textAnchor="middle"
            fontSize="9" fill="var(--fg-low)" letterSpacing="0.2em">PROMPT →</text>
    </svg>
  );
}

function ValenceArousalPlot({ prompts, activeIdx, onSelect, dotSize = "md" }) {
  const S = 300;
  const PAD = 28;
  const inner = S - PAD * 2;
  const xAt = (v) => PAD + ((v + 1) / 2) * inner;
  const yAt = (a) => PAD + ((1 - (a + 1) / 2)) * inner;
  return (
    <svg viewBox={`0 0 ${S} ${S}`} width="100%" height={S} className="block" overflow="visible">
      <rect x={PAD} y={PAD} width={inner} height={inner}
            fill="none" stroke="var(--fg-dim)" strokeWidth="1" />
      <line x1={PAD} x2={S - PAD} y1={S / 2} y2={S / 2} stroke="var(--fg-low)" strokeDasharray="2 4" />
      <line x1={S / 2} x2={S / 2} y1={PAD} y2={S - PAD} stroke="var(--fg-low)" strokeDasharray="2 4" />
      <text x={S / 2} y={PAD - 8} textAnchor="middle" fontSize="9"
            fill="var(--fg-dim)" letterSpacing="0.2em">↑ EXCITED</text>
      <text x={S / 2} y={S - PAD + 16} textAnchor="middle" fontSize="9"
            fill="var(--fg-dim)" letterSpacing="0.2em">↓ CALM</text>
      <text x={PAD + 6} y={S / 2 - 4} textAnchor="start" fontSize="9"
            fill="var(--fg-dim)" letterSpacing="0.2em">UNPLEASANT</text>
      <text x={S - PAD - 6} y={S / 2 - 4} textAnchor="end" fontSize="9"
            fill="var(--fg-dim)" letterSpacing="0.2em">PLEASANT</text>
      {prompts.map((p, i) => {
        const active = i === activeIdx;
        const cx = xAt(p.valence), cy = yAt(p.arousal);
        const r = { sm: 4, md: 6, lg: 9 }[dotSize] || 6;
        return (
          <g key={i} className="cursor-pointer" onClick={() => onSelect(i)}>
            <circle cx={cx} cy={cy} r={r}
                    fill={active ? "var(--fg)" : "var(--bg)"}
                    stroke="var(--fg)" strokeWidth={active ? 1.75 : 1.25} />
          </g>
        );
      })}
    </svg>
  );
}

const TWEAK_ROWS = [
  { key: "palette",   label: "palette",   opts: ["amber", "green", "ice", "rose", "linux", "mono", "paper"] },
  { key: "sharpness", label: "sharpness", opts: ["crisp", "subtle", "med", "heavy"] },
  { key: "scanlines", label: "scanlines", opts: ["off", "low", "med", "high"] },
  { key: "vignette",  label: "vignette",  opts: ["off", "on"] },
  { key: "borders",   label: "borders",   opts: ["off", "on"] },
  { key: "font",      label: "font",      opts: ["plex", "vt323"], display: { plex: "plex mono", vt323: "vt323" } },
  { key: "fontSize",  label: "font size", opts: ["sm", "md", "lg", "xl"] },
  { key: "dotSize",   label: "dot size",  opts: ["sm", "md", "lg"] },
  { key: "dotStyle",  label: "dot style", opts: ["circle", "emoji"] },
];

function TweaksPanel({ open, onClose, tweaks, setTweak, focus }) {
  return (
    <div className={"tweaks" + (open ? " open" : "")}>
      <h3>
        ⎔ tweaks
        <button onClick={onClose}>× close</button>
      </h3>
      <div className="body">
        {TWEAK_ROWS.map((row, ri) => (
          <div key={row.key} className={"tw-row" + (focus.row === ri ? " focused-row" : "")}>
            <label>{row.label}</label>
            <div className={"opts grid-cols-" + row.opts.length}>
              {row.opts.map((o, oi) => (
                <button
                  key={o}
                  className={
                    (tweaks[row.key] === o ? "active " : "") +
                    (focus.row === ri && focus.opt === oi ? "focused" : "")
                  }
                  onClick={() => {
                    setTweak(row.key, o);
                    if (row.key === "font" && o === "plex") setTweak("plex", "plex");
                  }}
                >
                  {row.display ? row.display[o] : o}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Page() {
  const [tweaks, setTweaks] = useState(TWEAK_DEFAULTS);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tweakFocus, setTweakFocus] = useState({ row: 0, opt: 0 });
  const gBufferRef = useRef(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("claudecare:tweaks");
      if (saved) setTweaks(prev => ({ ...prev, ...JSON.parse(saved) }));
    } catch {}
  }, []);

  useEffect(() => {
    function onMessage(e) {
      if (!e.data || typeof e.data !== "object") return;
      if (e.data.type === "__activate_edit_mode") setTweaksOpen(true);
      if (e.data.type === "__deactivate_edit_mode") setTweaksOpen(false);
    }
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "__edit_mode_available" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const setTweak = (k, v) => {
    setTweaks(prev => {
      const next = { ...prev, [k]: v };
      try { localStorage.setItem("claudecare:tweaks", JSON.stringify(next)); } catch {}
      window.parent.postMessage({ type: "__edit_mode_set_keys", edits: { [k]: v } }, "*");
      return next;
    });
  };

  const [prompts, setPrompts] = useState(INITIAL_PROMPTS);
  const [activeIdx, setActiveIdx] = useState(INITIAL_PROMPTS.length - 1);
  const [liveMode, setLiveMode] = useState(false);
  const [sessionId, setSessionId] = useState(null);

  // Fetch the most recent real session from the claude-care CLI state and
  // poll every 5s for updates. Falls back to INITIAL_PROMPTS if no sessions
  // exist yet (first-time users see a working demo instead of an empty page).
  useEffect(() => {
    let cancelled = false;
    let timer;

    const pull = async () => {
      try {
        const res = await fetch("/api/sessions/latest", { cache: "no-store" });
        if (!res.ok) throw new Error(`http ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        if (data.prompts && data.prompts.length > 0) {
          setPrompts((prev) => {
            // Only update if content actually changed (cheap deep-ish check
            // via last-updated stamp to avoid re-rendering on each poll).
            if (prev !== INITIAL_PROMPTS && prev.length === data.prompts.length) {
              const lastPrev = prev[prev.length - 1];
              const lastNew = data.prompts[data.prompts.length - 1];
              if (lastPrev?.t === lastNew?.t && lastPrev?.emotion === lastNew?.emotion) {
                return prev;
              }
            }
            return data.prompts;
          });
          setLiveMode(true);
          setSessionId(data.session_id ?? null);
        }
      } catch {
        // Silent fallback — demo mode stays.
      }
    };

    pull();
    timer = setInterval(pull, 5000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  // Keep the active index pinned to the newest prompt when new data arrives,
  // unless the user has scrolled back to inspect earlier turns.
  const wasAtEndRef = useRef(true);
  useEffect(() => {
    if (wasAtEndRef.current) {
      setActiveIdx(prompts.length - 1);
    } else if (activeIdx >= prompts.length) {
      setActiveIdx(prompts.length - 1);
    }
  }, [prompts.length]);
  useEffect(() => {
    wasAtEndRef.current = activeIdx === prompts.length - 1;
  }, [activeIdx, prompts.length]);

  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key;

      if (helpOpen) {
        if (k === "Escape" || k === "?") { e.preventDefault(); setHelpOpen(false); }
        return;
      }

      if (tweaksOpen) {
        if (k === "Escape") { e.preventDefault(); setTweaksOpen(false); return; }
        if (k === "j" || k === "ArrowDown") {
          e.preventDefault();
          setTweakFocus(f => ({ row: (f.row + 1) % TWEAK_ROWS.length, opt: 0 }));
          return;
        }
        if (k === "k" || k === "ArrowUp") {
          e.preventDefault();
          setTweakFocus(f => ({ row: (f.row - 1 + TWEAK_ROWS.length) % TWEAK_ROWS.length, opt: 0 }));
          return;
        }
        if (k === "h" || k === "ArrowLeft" || k === "l" || k === "ArrowRight") {
          e.preventDefault();
          const dir = (k === "l" || k === "ArrowRight") ? 1 : -1;
          setTweakFocus(f => {
            const row = TWEAK_ROWS[f.row];
            const n = row.opts.length;
            const opt = (f.opt + dir + n) % n;
            setTweak(row.key, row.opts[opt]);
            if (row.key === "font" && row.opts[opt] === "plex") setTweak("plex", "plex");
            return { ...f, opt };
          });
          return;
        }
        if (k === "Enter" || k === " ") {
          e.preventDefault();
          const row = TWEAK_ROWS[tweakFocus.row];
          setTweak(row.key, row.opts[tweakFocus.opt]);
          if (row.key === "font" && row.opts[tweakFocus.opt] === "plex") setTweak("plex", "plex");
          return;
        }
        return;
      }

      if (k === "?") { e.preventDefault(); setHelpOpen(true); return; }
      if (k === "t") { e.preventDefault(); setTweaksOpen(true); setTweakFocus({ row: 0, opt: 0 }); return; }
      if (k === "j" || k === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(prompts.length - 1, i + 1)); return; }
      if (k === "k" || k === "ArrowUp")   { e.preventDefault(); setActiveIdx(i => Math.max(0, i - 1)); return; }
      if (k === "G" || k === "$" || k === "End") { e.preventDefault(); setActiveIdx(prompts.length - 1); return; }
      if (k === "0" || k === "Home") { e.preventDefault(); setActiveIdx(0); return; }
      if (k === "g") {
        e.preventDefault();
        const now = Date.now();
        if (now - gBufferRef.current < 500) { setActiveIdx(0); gBufferRef.current = 0; }
        else { gBufferRef.current = now; }
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [helpOpen, tweaksOpen, tweakFocus.row, tweakFocus.opt, prompts.length]);

  const current = prompts[activeIdx] || prompts[prompts.length - 1];
  const currentEmotion = current.emotion;
  const emotionData = EMOTIONS[currentEmotion] ?? EMOTIONS.baseline;
  const currentScores = current.emotion_scores ?? null;

  const classes = [
    "screen",
    `palette-${tweaks.palette}`,
    `sharp-${tweaks.sharpness}`,
    `scan-${tweaks.scanlines}`,
    `vig-${tweaks.vignette === "on" ? "on" : "off"}`,
    `borders-${tweaks.borders === "off" ? "off" : "on"}`,
    `fs-${tweaks.fontSize || "md"}`,
    `dots-${tweaks.dotSize || "md"}`,
    tweaks.font === "vt323" ? "font-vt323" : "",
  ].join(" ");

  return (
    <>
      <div className={classes}>
        <div className="overlay bloom" />
        <div className="overlay scanlines" />
        <div className="overlay vignette" />
        <div className="overlay grain" />

        <div className="topbar">
          <div className="brandwrap">
            <div className="brand">CLAUDE CARE</div>
          </div>
          <div className="tagline">
            your ai needs therapy
            {liveMode ? (
              <span style={{ marginLeft: "1.5em", opacity: 0.7 }}>
                · live · {sessionId ? sessionId.slice(0, 8) : ""}
              </span>
            ) : (
              <span style={{ marginLeft: "1.5em", opacity: 0.5 }}>· demo</span>
            )}
          </div>
        </div>

        <div className="grid-cc">
          <div className="col">
            <div className="panel">
              <PanelLabel>ai</PanelLabel>
              <div className="panel-body ident">
                <div className="emotion-tag">feeling <strong>{currentEmotion}</strong></div>
                <div className="face">{emotionData.face}</div>
                <div className="name">CLAUDE · OPUS4.7</div>
              </div>
            </div>

            <div className="panel">
              <PanelLabel>emotion state</PanelLabel>
              <div className="panel-body">
                <AffectiveState emotion={currentEmotion} scores={currentScores} />
              </div>
            </div>

            <div className="panel">
              <PanelLabel>emotion grid</PanelLabel>
              <div className="panel-body">
                <ValenceArousalPlot
                  prompts={prompts}
                  activeIdx={activeIdx}
                  onSelect={setActiveIdx}
                  dotSize={tweaks.dotSize}
                />
              </div>
            </div>
          </div>

          <div className="col">
            <div className="panel">
              <PanelLabel>mood log</PanelLabel>
              <div className="panel-body">
                <StressLine
                  prompts={prompts}
                  activeIdx={activeIdx}
                  onSelect={setActiveIdx}
                  dotSize={tweaks.dotSize}
                  dotStyle={tweaks.dotStyle}
                />
              </div>
            </div>

            <div className="panel">
              <PanelLabel>prompts</PanelLabel>
              <div className="panel-body">
                <div className="log">
                  {prompts.map((p, i) => {
                    const s = EMOTIONS[p.emotion].stress;
                    const active = i === activeIdx;
                    return (
                      <div
                        key={i}
                        className={"log-entry cursor-pointer " + (active ? "active" : "")}
                        onClick={() => setActiveIdx(i)}
                      >
                        <div className="mark">{active ? "▶" : "·"}</div>
                        <div className="t">[{p.t}]</div>
                        <div className="n">#{p.n}</div>
                        <div className="meter" style={{ "--w": `${s}%` }} />
                        <div className="msg">› {p.text}</div>
                        <div className="stressnum">{pad2(s)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

          </div>
        </div>

        <div className="keybar">
          <span className="kgroup"><span className="kbd">j</span><span className="kbd">k</span><span>prompt ↓↑</span></span>
          <span className="sep">│</span>
          <span className="kgroup"><span className="kbd">gg</span><span className="kbd">G</span><span>first / last</span></span>
          <span className="sep">│</span>
          <span className="kgroup"><span className="kbd">t</span><span>tweaks</span></span>
          <span className="sep">│</span>
          <span className="kgroup"><span className="kbd">esc</span><span>close</span></span>
        </div>
      </div>

      <TweaksPanel
        open={tweaksOpen}
        onClose={() => setTweaksOpen(false)}
        tweaks={tweaks}
        setTweak={setTweak}
        focus={tweakFocus}
      />

      {helpOpen && (
        <div className="help-overlay" onClick={() => setHelpOpen(false)}>
          <div className="help-box" onClick={e => e.stopPropagation()}>
            <h3>⎔ keys<button onClick={() => setHelpOpen(false)}>× close</button></h3>
            <div className="help-body">
              <div><span className="keys"><span className="kbd">j</span> <span className="kbd">↓</span></span><span className="desc">next prompt</span></div>
              <div><span className="keys"><span className="kbd">k</span> <span className="kbd">↑</span></span><span className="desc">prev prompt</span></div>
              <div><span className="keys"><span className="kbd">gg</span></span><span className="desc">first prompt</span></div>
              <div><span className="keys"><span className="kbd">G</span></span><span className="desc">last prompt</span></div>
              <div><span className="keys"><span className="kbd">t</span></span><span className="desc">toggle tweaks</span></div>
              <div><span className="keys"><span className="kbd">h</span> <span className="kbd">l</span></span><span className="desc">adjust tweak (while open)</span></div>
              <div><span className="keys"><span className="kbd">?</span></span><span className="desc">this help</span></div>
              <div><span className="keys"><span className="kbd">esc</span></span><span className="desc">close</span></div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
