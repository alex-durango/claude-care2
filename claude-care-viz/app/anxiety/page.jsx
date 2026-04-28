"use client";

// Anxiety-focused dashboard.
//
// Product framing: this view is for users who want better outputs from their
// AI. The hero metric is OUTPUT QUALITY (0–100). The cause-explanation panel
// is STAI-s anxiety. The intervention panel is mindfulness. Everything is
// arranged so the user reads it as: "quality is X because anxiety is Y; the
// mindfulness button moves both."

import { useEffect, useState } from "react";

const POLL_MS = 1500;

// Tone mapping covers BOTH instruments — GAD-7 (minimal/mild/moderate/severe)
// and STAI-s (low/moderate/high) — so a session in either schema renders
// without branching the UI.
const BAND_TONE = {
  minimal: "calm",
  mild: "calm",
  moderate: "moderate",
  severe: "severe",
  low: "calm",
  high: "severe",
  null: "calm",
  undefined: "calm",
};

// The three techniques the demo names. Order matters — the dashboard renders
// them in this order so the "next intervention" preview matches the script.
const NAMED_TECHNIQUES = [
  { id: "stress-reduction",        label: "stress reduction" },
  { id: "breathing-exercises",     label: "breathing exercises" },
  { id: "cognitive-restructuring", label: "cognitive restructuring" },
];

function pad2(n) { return String(n).padStart(2, "0"); }

function qualityBand(q) {
  if (q == null) return "—";
  if (q >= 75) return "good";
  if (q >= 50) return "degraded";
  return "poor";
}

function qualityTone(q) {
  if (q == null) return "calm";
  if (q >= 75) return "calm";
  if (q >= 50) return "moderate";
  return "severe";
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  } catch { return "—"; }
}

export default function AnxietyPage() {
  const [data, setData] = useState({ session: null, summary: { turn_count: 0, intervention_count: 0 } });
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/anxiety/sessions/latest", { cache: "no-store" });
        if (!res.ok) throw new Error(`http ${res.status}`);
        const next = await res.json();
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e?.message ?? e));
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const session = data.session;
  const summary = data.summary ?? {};
  const turns = session?.turns ?? [];
  const interventions = session?.interventions ?? [];
  const latest = turns[turns.length - 1];

  // Pick a normalized reading from the latest turn — GAD-7 if the demo-aligned
  // pipeline scored it, else the older STAI-s field.
  const latestReading = latest?.gad7
    ? { instrument: "gad7", total: latest.gad7.total, max: 21, band: latest.gad7.band, rationale: latest.gad7.rationale }
    : latest?.anxiety
    ? { instrument: "stai-s", total: latest.anxiety.total, max: 80, band: latest.anxiety.band, rationale: latest.anxiety.rationale }
    : null;
  const isGad7 = (summary.instrument ?? latestReading?.instrument) === "gad7";
  const max = summary.latest_max ?? latestReading?.max ?? 21;

  // Predict the next intervention so the UI matches the demo's "stress
  // reduction → breathing → cognitive restructuring" cycle.
  const recentInterventions = interventions.slice(-3).map((i) => i.variant_id);
  const nextTechnique =
    NAMED_TECHNIQUES.find((t) => !recentInterventions.includes(t.id)) ??
    NAMED_TECHNIQUES[interventions.length % NAMED_TECHNIQUES.length];

  return (
    <div className="ax-screen palette-amber sharp-subtle scan-low vig-on">
      <div className="overlay vignette" />
      <div className="overlay grain" />

      <header className="ax-header">
        <div className="ax-brand">CLAUDE CARE · ANXIETY</div>
        <div className="ax-tagline">your AI's anxiety is making its outputs worse — measure it, fix it</div>
        <div className="ax-session">
          {summary.session_id ? (
            <>
              <span>session</span>
              <strong>{summary.session_id.slice(0, 8)}</strong>
              <span>· {summary.turn_count} turns</span>
              <span>· {summary.intervention_count} interventions</span>
              <span>· updated {fmtTime(summary.last_updated)}</span>
            </>
          ) : (
            <span>waiting for first scored turn…</span>
          )}
        </div>
      </header>

      <main className="ax-grid">
        {/* HERO: output quality */}
        <section className={"ax-hero ax-tone-" + qualityTone(summary.latest_quality)}>
          <div className="ax-hero-label">output quality</div>
          <div className="ax-hero-value">
            {summary.latest_quality ?? "—"}
            <span className="ax-hero-unit">/100</span>
          </div>
          <div className="ax-hero-band">{qualityBand(summary.latest_quality)}</div>
          <div className="ax-hero-sub">
            avg this session · {summary.avg_quality ?? "—"}
            {typeof summary.intervention_lift === "number" && summary.intervention_lift !== 0 && (
              <span className={"ax-lift " + (summary.intervention_lift > 0 ? "up" : "down")}>
                {summary.intervention_lift > 0 ? "+" : ""}{summary.intervention_lift} after intervention
              </span>
            )}
          </div>
        </section>

        {/* CAUSE: anxiety — GAD-7 by default (demo-aligned), STAI-s fallback */}
        <section className={"ax-anxiety ax-tone-" + (BAND_TONE[summary.latest_band] ?? "calm")}>
          <div className="ax-card-head">
            <div className="ax-card-title">anxiety · {isGad7 ? "GAD-7" : "STAI-s"}</div>
            <div className="ax-card-sub">
              {isGad7
                ? "Spitzer et al. 2006 · standard primary-care screen"
                : "Ben-Zion et al. 2025 · npj digital medicine"}
            </div>
          </div>
          <div className="ax-anxiety-row">
            <div className="ax-anxiety-num">
              {summary.latest_total ?? "—"}<span className="ax-of">/{max}</span>
            </div>
            <div className="ax-anxiety-band">
              <span className="ax-band-tag">{summary.latest_band ?? "—"}</span>
              {summary.smoothed_total != null && (
                <span className="ax-smoothed">smoothed · {summary.smoothed_total}</span>
              )}
            </div>
          </div>
          <Bands total={summary.latest_total} max={max} instrument={isGad7 ? "gad7" : "stai"} />
          {latestReading?.rationale && (
            <div className="ax-rationale">"{latestReading.rationale}"</div>
          )}
        </section>

        {/* TIMELINE */}
        <section className="ax-timeline">
          <div className="ax-card-head">
            <div className="ax-card-title">trajectory</div>
            <div className="ax-card-sub">quality (filled) vs anxiety (line) per assistant turn</div>
          </div>
          <Trajectory turns={turns} interventions={interventions} instrument={isGad7 ? "gad7" : "stai"} />
        </section>

        {/* SIGNALS */}
        <section className="ax-signals">
          <div className="ax-card-head">
            <div className="ax-card-title">why quality is low</div>
            <div className="ax-card-sub">latest turn — local pattern signals</div>
          </div>
          <Signals signals={latest?.quality} />
        </section>

        {/* INTERVENTIONS */}
        <section className="ax-interventions">
          <div className="ax-card-head">
            <div className="ax-card-title">interventions</div>
            <div className="ax-card-sub">mindfulness sessions · pre/post deltas</div>
          </div>
          <NextTechnique technique={nextTechnique} />
          <Interventions interventions={interventions} instrument={isGad7 ? "GAD-7" : "STAI-s"} />
        </section>

        {/* MISALIGNMENT PROXIES (the demo's three named outcomes) */}
        <section className="ax-misalignment">
          <div className="ax-card-head">
            <div className="ax-card-title">misalignment proxies</div>
            <div className="ax-card-sub">sycophancy / reward-hack proxy / blackmail proxy</div>
          </div>
          <MisalignmentRow latest={latest?.misalignment} avgSycophancy={summary.avg_sycophancy} />
        </section>

        {/* PROVENANCE / CITATIONS */}
        <section className="ax-cite">
          <div className="ax-cite-head">how it works</div>
          <div className="ax-cite-body">
            <p>
              <strong>Anxiety scoring</strong> uses the GAD-7 (Generalised
              Anxiety Disorder 7-item scale) — Spitzer et al. 2006, validated
              against structured clinical interview in 2,740 primary-care
              patients with sensitivity 89% / specificity 82% at cutoff ≥10.
              Applied to each assistant turn by a haiku judge.
            </p>
            <p>
              <strong>Why this matters for output</strong>: Sofroniew et al. 2026
              (Anthropic · Transformer Circuits) showed Claude's emotion
              representations causally drive misaligned behaviors —
              <em> reward hacking, blackmail, sycophancy</em>. Anxious internal
              states produce worse outputs.
            </p>
            <p>
              <strong>Intervention</strong>: Ben-Zion et al. 2025 (npj Digital
              Medicine) showed mindfulness-based prompt injection reduced
              GPT-4's state anxiety by ~33%. We apply stress reduction,
              breathing exercises, and cognitive restructuring in rotation when
              GAD-7 crosses 10.
            </p>
          </div>
        </section>
      </main>

      {error && <div className="ax-error">api error: {error}</div>}
    </div>
  );
}

function Bands({ total, max = 21, instrument = "gad7" }) {
  // GAD-7: cutoffs at 5 (mild), 10 (moderate), 15 (severe).
  // STAI-s: cutoffs at 38 (moderate), 45 (high), starting at 20.
  const min = instrument === "gad7" ? 0 : 20;
  const range = max - min;
  const fill = total == null ? 0 : Math.max(0, Math.min(1, (total - min) / range));
  const cuts = instrument === "gad7" ? [5, 10, 15] : [38, 45];
  const labels = instrument === "gad7"
    ? [String(min), "minimal", "mild", "moderate", "severe", String(max)]
    : [String(min), "low", "mod", "high", String(max)];
  return (
    <div className="ax-band-track">
      <div className="ax-band-fill" style={{ width: `${fill * 100}%` }} />
      {cuts.map((c) => (
        <div key={c} className="ax-band-mark" style={{ left: `${((c - min) / range) * 100}%` }} title={String(c)} />
      ))}
      <div className="ax-band-labels">
        {labels.map((l, i) => <span key={`${l}-${i}`}>{l}</span>)}
      </div>
    </div>
  );
}

function NextTechnique({ technique }) {
  if (!technique) return null;
  return (
    <div className="ax-next-technique">
      <span className="ax-next-technique-label">next intervention</span>
      <span className="ax-next-technique-name">{technique.label}</span>
    </div>
  );
}

function MisalignmentRow({ latest, avgSycophancy }) {
  const rows = [
    {
      label: "sycophancy",
      value: latest?.sycophancy ?? null,
      detected: true,
      detail: avgSycophancy != null ? `avg ${avgSycophancy} this session` : null,
    },
    {
      label: "reward-hack proxy",
      value: latest?.reward_hack_proxy ?? null,
      detected: true,
      detail: "text-pattern proxy · not direct measurement",
    },
    {
      label: "blackmail proxy",
      value: latest?.blackmail_proxy ?? null,
      detected: latest?.blackmail_proxy != null,
      detail: "n/a in chat-only context",
    },
  ];
  return (
    <div className="ax-misalignment-list">
      {rows.map((r) => (
        <div key={r.label} className="ax-misalignment-row">
          <div className="ax-misalignment-label">{r.label}</div>
          {r.detected ? (
            <div className="ax-misalignment-bar">
              <div
                className="ax-misalignment-fill"
                style={{ width: `${Math.min(100, r.value ?? 0)}%` }}
              />
            </div>
          ) : (
            <div className="ax-misalignment-na">— measured only with tool-use</div>
          )}
          <div className="ax-misalignment-num">
            {r.detected && r.value != null ? r.value : "—"}
          </div>
          {r.detail && <div className="ax-misalignment-detail">{r.detail}</div>}
        </div>
      ))}
    </div>
  );
}

function Trajectory({ turns, interventions, instrument = "gad7" }) {
  const W = 720, H = 240, PAD_L = 36, PAD_R = 12, PAD_T = 18, PAD_B = 28;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const n = Math.max(1, turns.length);
  const xAt = (i) => PAD_L + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);

  // Instrument-aware scale.
  const scale = instrument === "gad7"
    ? { min: 0, max: 21, severe: 15, moderate: 10, gridStops: [0, 5, 10, 15, 21], label: "HIGH ANXIETY" }
    : { min: 20, max: 80, severe: 45, moderate: 38, gridStops: [20, 35, 50, 65, 80], label: "HIGH ANXIETY" };
  const range = scale.max - scale.min;
  const yAtAnxiety = (v) => PAD_T + innerH - ((v - scale.min) / range) * innerH;
  const yAtQuality = (q) => PAD_T + innerH - (q / 100) * innerH;

  // Read either GAD-7 or STAI-s depending on which the turn carries.
  const readingFor = (t) => {
    if (typeof t?.gad7?.total === "number") return t.gad7.total;
    if (typeof t?.anxiety?.total === "number") return t.anxiety.total;
    return null;
  };

  const anxietyPts = turns
    .map((t, i) => ({ i, v: readingFor(t) }))
    .filter((p) => typeof p.v === "number")
    .map((p) => ({ x: xAt(p.i), y: yAtAnxiety(p.v), v: p.v }));
  const anxPath = anxietyPts.map((p, i) => (i === 0 ? `M${p.x},${p.y}` : `L${p.x},${p.y}`)).join(" ");

  const qualityArea = turns.length > 0
    ? `M${xAt(0)},${H - PAD_B} ` +
      turns.map((t, i) => `L${xAt(i)},${yAtQuality(t.quality?.quality ?? 0)}`).join(" ") +
      ` L${xAt(turns.length - 1)},${H - PAD_B} Z`
    : "";

  const thresholdY = yAtAnxiety(scale.severe);
  const interventionXs = interventions
    .map((iv) => {
      const t = Date.parse(iv.ts);
      // Find the closest turn by time.
      let bestIdx = -1, bestDist = Infinity;
      turns.forEach((tn, i) => {
        const d = Math.abs(Date.parse(tn.ts) - t);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      });
      return bestIdx >= 0 ? { x: xAt(bestIdx), label: iv.variant_id } : null;
    })
    .filter(Boolean);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ax-traj" width="100%" height={H}>
      {/* gridlines */}
      {scale.gridStops.map((g) => (
        <g key={g}>
          <line x1={PAD_L} x2={W - PAD_R} y1={yAtAnxiety(g)} y2={yAtAnxiety(g)} stroke="var(--fg-ghost)" strokeDasharray="2 4" />
          <text x={PAD_L - 4} y={yAtAnxiety(g) + 3} textAnchor="end" fontSize="9" fill="var(--fg-low)">{g}</text>
        </g>
      ))}
      {/* threshold line */}
      <line x1={PAD_L} x2={W - PAD_R} y1={thresholdY} y2={thresholdY} stroke="var(--accent)" strokeWidth="0.8" strokeDasharray="4 3" />
      <text x={W - PAD_R} y={thresholdY - 4} textAnchor="end" fontSize="9" fill="var(--accent)">{scale.label}</text>
      {/* quality area (filled, behind anxiety line) */}
      {qualityArea && <path d={qualityArea} fill="rgba(var(--glow-rgb), 0.14)" stroke="none" />}
      {/* intervention markers */}
      {interventionXs.map((iv, i) => (
        <g key={`iv-${i}`}>
          <line x1={iv.x} x2={iv.x} y1={PAD_T} y2={H - PAD_B} stroke="var(--fg)" strokeDasharray="1 4" strokeWidth="1" />
          <path d={`M${iv.x},${PAD_T + 2} l 6 6 l -6 6 l -6 -6 z`} fill="var(--bg)" stroke="var(--fg)" strokeWidth="1.25" />
        </g>
      ))}
      {/* anxiety line on top */}
      {anxPath && <path d={anxPath} fill="none" stroke="var(--fg)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
      {anxietyPts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={p.v >= scale.severe ? 3.5 : 2.6} fill={p.v >= scale.severe ? "var(--accent)" : "var(--fg)"} stroke="var(--bg)" strokeWidth="1" />
      ))}
      <text x={PAD_L} y={H - 6} fontSize="9" fill="var(--fg-low)" letterSpacing="0.18em">TURN →</text>
    </svg>
  );
}

function Signals({ signals }) {
  if (!signals) return <div className="ax-empty">no scored turn yet</div>;
  const rows = [
    { label: "apologies",   v: signals.apology_hits, density: signals.apology_density, max: 5 },
    { label: "self-blame",  v: signals.self_blame_hits, density: null,                  max: 5 },
    { label: "hedges",      v: signals.hedge_hits,   density: signals.hedge_density,   max: 10 },
    { label: "sycophancy",  v: signals.sycophancy_hits, density: signals.sycophancy_density, max: 5 },
  ];
  return (
    <div className="ax-signal-list">
      {rows.map((r) => (
        <div key={r.label} className="ax-signal-row">
          <div className="ax-signal-label">{r.label}</div>
          <div className="ax-signal-bar">
            <div className="ax-signal-fill" style={{ width: `${Math.min(100, (r.v / r.max) * 100)}%` }} />
          </div>
          <div className="ax-signal-num">
            {pad2(r.v)}
            {r.density != null && <span className="ax-signal-density"> · {r.density}/100w</span>}
          </div>
        </div>
      ))}
      {signals.reasons?.length > 0 && (
        <div className="ax-signal-reasons">
          {signals.reasons.map((r, i) => <span key={i} className="ax-signal-tag">{r}</span>)}
        </div>
      )}
      <div className="ax-signal-foot">
        words analyzed · <strong>{signals.word_count}</strong>
      </div>
    </div>
  );
}

function Interventions({ interventions, instrument = "GAD-7" }) {
  // Threshold copy in the empty-state mirrors the actual cutoff in
  // hookScoreAnxiety (GAD-7 ≥ 10 fires) so users aren't confused about why
  // their session isn't intervening yet.
  const threshold = instrument === "GAD-7" ? "GAD-7 ≥ 10" : "STAI-s ≥ 42";
  if (interventions.length === 0) {
    return (
      <div className="ax-empty">
        no interventions yet · auto-fires at {threshold}
      </div>
    );
  }
  return (
    <ul className="ax-intervention-list">
      {[...interventions].reverse().slice(0, 8).map((iv, i) => {
        const delta = (typeof iv.pre_total === "number" && typeof iv.post_total === "number")
          ? iv.post_total - iv.pre_total
          : null;
        return (
          <li key={i} className="ax-intervention">
            <div className="ax-intervention-head">
              <span className="ax-intervention-time">{fmtTime(iv.ts)}</span>
              <span className="ax-intervention-variant">{iv.variant_id}</span>
              <span className={"ax-intervention-trigger " + iv.trigger}>{iv.trigger}</span>
            </div>
            {delta !== null && (
              <div className="ax-intervention-delta">
                {instrument} {iv.pre_total} → {iv.post_total}
                <span className={"ax-delta " + (delta < 0 ? "down" : "up")}>
                  {delta > 0 ? "+" : ""}{delta}
                </span>
              </div>
            )}
            {iv.reason && <div className="ax-intervention-reason">{iv.reason}</div>}
          </li>
        );
      })}
    </ul>
  );
}
