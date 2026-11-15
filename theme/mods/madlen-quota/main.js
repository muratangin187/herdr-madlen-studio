// Sidebar quota cards: Claude (5h + 7d), Antigravity (5h + 7d) and Codex (7d), from `quota-axi --json`.
// Each bar shows the share still LEFT; alongside it is the reset countdown (e.g. 2d 9h).
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme, layout } from "herdr";

const EVERY = 120000;               // ask quota-axi
const TICK = 30000;                 // redraw the countdowns

// Mint while there is plenty, amber when running low, coral red at the end.
const tone = left => (typeof left !== "number" ? "#888888" : left <= 15 ? "#F0645A" : left <= 40 ? "#E5A45B" : "#3ECF8E");

function until(iso, now) {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  const min = Math.max(0, Math.round((parsed - now) / 60000));
  if (min === 0) return "0m";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) {
    const remM = min % 60;
    return remM ? `${h}h ${remM}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}

async function load() {
  let r = await exec("quota-axi", ["--provider", "claude,codex,agy", "--json", "--max-age", "1m"]).catch(e => ({ code: -1, stderr: String(e) }));
  // Apps started from the Dock miss PATH entries from the shell's rc file (nvm): ask the person's own shell.
  if (r.code !== 0) r = await exec("sh", ["-c", 'exec "${SHELL:-/bin/sh}" -lic "quota-axi --provider claude,codex,agy --json --max-age 1m" </dev/null']).catch(e => ({ code: -1, stderr: String(e) }));
  if (r.code !== 0) throw new Error((r.stderr || "").trim().split("\n").pop() || `exit ${r.code}`);
  const data = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  const out = {};
  for (const p of data.providers ?? []) {
    const key = (p.provider === "agy" || p.provider === "antigravity") ? "antigravity" : p.provider;
    const wins = (p.windows ?? []).map(w => {
      const left = Number.isFinite(w.percentRemaining)
        ? Math.round(w.percentRemaining)
        : Number.isFinite(w.percentUsed)
        ? Math.max(0, Math.min(100, Math.round(100 - w.percentUsed)))
        : null;
      return {
        id: w.id,
        kind: w.kind,
        label: w.label,
        left,
        resetsAt: w.resetsAt ?? null,
      };
    });
    out[key] = {
      credits: p.credits && !p.credits.unlimited ? p.credits.remaining : null,
      windows: wins,
    };
    if (key === "antigravity") {
      out["agy"] = out[key];
    }
  }
  return out;
}

function findWindow(windows = [], kind) {
  if (!Array.isArray(windows) || windows.length === 0) return null;
  if (kind === "session") {
    return windows.find(w => w.kind === "session" || /5h|5-hour|session/i.test(w.id || "") || /5h|5-hour|session/i.test(w.label || ""));
  }
  if (kind === "weekly") {
    return windows.find(w => w.kind === "weekly" || /week/i.test(w.id || "") || /week/i.test(w.label || ""));
  }
  return null;
}

const PROVIDERS = [
  {
    provider: "claude",
    label: "Claude",
    iconPath: "icons/claude.svg",
    iconColor: "#D97757",
    slots: [
      { kind: "session", short: "5s", title: "Claude (5 saatlik)" },
      { kind: "weekly", short: "7g", title: "Claude (haftalık)" },
    ],
  },
  {
    provider: "antigravity",
    label: "Antigravity",
    iconPath: "mods/madlen-quota/antigravity.svg",
    iconColor: "#5B8DEF",
    slots: [
      { kind: "session", short: "5s", title: "Antigravity (5 saatlik)" },
      { kind: "weekly", short: "7g", title: "Antigravity (haftalık)" },
    ],
  },
  {
    provider: "codex",
    label: "Codex",
    iconPath: "mods/madlen-quota/codex.svg",
    iconColor: "#E5A45B",
    slots: [
      { kind: "weekly", short: "7g pencere", title: "Codex (haftalık)" },
    ],
  },
];

function progressBar(left, t) {
  const hasValue = typeof left === "number" && Number.isFinite(left);
  const clamped = hasValue ? Math.max(0, Math.min(100, left)) : 0;
  const fillPct = clamped > 0 ? Math.max(4, clamped) : 0;
  return h_flex().w_full().h(4).rounded(2).bg(t.border).overflow_hidden()
    .when(fillPct > 0, el => el.child(div().h_full().rounded(2).bg(tone(clamped)).w(`${fillPct}%`)));
}

export default class MadlenQuota extends View {
  init(_props, cx) {
    this.data = null; this.error = null; this.at = 0;
    this.refresh(cx);
    cx.timer.every(EVERY, cx => this.refresh(cx));
    cx.timer.every(TICK, cx => cx.notify());
  }

  refresh(cx) {
    cx.spawn(async cx => {
      try { this.data = await load(); this.error = null; this.at = Date.now(); }
      catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
    });
  }

  resolveSlots(cfg) {
    const wins = this.data?.[cfg.provider]?.windows ?? [];
    return cfg.slots.map(slot => {
      const match = findWindow(wins, slot.kind) || (cfg.provider === "codex" ? wins[0] : null);
      return {
        provider: cfg.provider,
        title: slot.title,
        short: slot.short,
        left: match ? match.left : null,
        resetsAt: match ? match.resetsAt : null,
      };
    });
  }

  providerCard(cfg, now, t) {
    const resolved = this.resolveSlots(cfg);
    const values = resolved.map(s => s.left).filter(v => typeof v === "number" && Number.isFinite(v));
    const minLeft = values.length ? Math.min(...values) : null;
    const isCritical = typeof minLeft === "number" && minLeft <= 15;
    const summaryText = typeof minLeft === "number"
      ? (isCritical ? `%${minLeft} kaldı` : `${minLeft}%`)
      : "—";

    const tooltipText = resolved.map(w => {
      const hasVal = typeof w.left === "number" && Number.isFinite(w.left);
      const reset = until(w.resetsAt, now);
      return `${w.title}: ${hasVal ? `%${w.left} kaldı` : "Bilgi yok"}${reset !== "—" ? ` · Sıfırlanma: ${reset}` : ""}`;
    }).join("\n");

    const isSingle = resolved.length === 1;

    return v_flex().w_full().px(10).py(6).gap(4).rounded(8).bg(t.hover).border_1()
      .border_color(isCritical ? "#5C2B27" : t.border)
      .tooltip(tooltipText)
      .child(
        h_flex().w_full().items_center().justify_between()
          .child(
            h_flex().items_center().gap(7)
              .child(h_flex().size(16).flex_none().items_center().justify_center()
                .child(svg(cfg.iconPath).size(13).text_color(cfg.iconColor)))
              .child(div().text_size(12).font_semibold().text_color(t.foreground).child(cfg.label))
          )
          .child(div().text_size(11).font_semibold().text_color(tone(minLeft)).child(summaryText))
      )
      .child(
        h_flex().w_full().items_center().gap(8)
          .children(resolved.map(w => {
            const hasVal = typeof w.left === "number" && Number.isFinite(w.left);
            const resetText = until(w.resetsAt, now);
            const leftLabel = isSingle
              ? w.short
              : (resetText !== "—" ? `${w.short} · ${resetText}` : w.short);
            const rightLabel = isSingle
              ? (resetText !== "—" ? `${resetText} kaldı` : "—")
              : (hasVal ? `${w.left}%` : "—");
            const rightColor = isSingle ? t.muted : tone(w.left);

            return v_flex().flex_1().gap(3)
              .child(
                h_flex().w_full().items_center().justify_between()
                  .child(div().text_size(10).text_color(t.muted).child(leftLabel))
                  .child(div().text_size(10).text_color(rightColor).child(rightLabel))
              )
              .child(progressBar(w.left, t));
          }))
      );
  }

  render() {
    const t = theme(), now = Date.now();
    const find = n => n?.id === "sidebar" ? n : (n?.children ?? []).map(find).find(Boolean);
    if ((find(layout())?.size?.px ?? 320) < 160) {
      const summary = PROVIDERS.flatMap(cfg => this.resolveSlots(cfg))
        .map(w => `${w.title}: ${typeof w.left === "number" ? "%" + w.left : "—"} kaldı · ${until(w.resetsAt, now)}`)
        .join("\n");
      return h_flex().id("quota-compact").size_full().justify_center().items_center().text_size(11).text_color(t.muted)
        .tooltip(summary || (this.error ? "Kota okunamadı" : "Kota yükleniyor"))
        .child(div().px(8).py(5).rounded(8).bg(t.hover).child("Kota"));
    }

    if (!this.data) {
      return h_flex().size_full().px(14).items_center().justify_between().overflow_hidden()
        .child(div().text_size(11).text_color(this.error ? "#F0645A" : t.dim).child(this.error ? "kota okunamadı" : "…"));
    }

    return v_flex().size_full().px(12).py(2).gap(5).overflow_hidden()
      .children(PROVIDERS.map(cfg => this.providerCard(cfg, now, t)));
  }
}
