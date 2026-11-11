// PR'lar: madlenio'daki açık (ve son 7 günde merge edilen) PR'ların, Linear numarasına göre.
// API, Teacher ve Exam'de preview durumu; "Preview al" yalnızca iki tıklamayla o PR'a
// `@madlen-agent deploy` yorumu yazar. GitHub'a `gh` ile (kişinin kendi oturumu) bağlanır.
// Linear başlıkları isteğe bağlıdır: Linear eklentisinin herdr-linear aracı ve oturumu varsa okunur.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme, appHome, readTextFile } from "herdr";
import { ORG, query, TRIGGER, canPreview, repoLabel, groupPrs, ago, cleanTitle } from "./logic.js";

const POLL_MS = 60000;
const CONFIRM_MS = 5000;

// Dock'tan açılan uygulama kabuğun PATH'ini görmeyebilir: gh bulunamazsa kişinin kendi kabuğuna sorulur.
let ghPath = null;
async function gh(args) {
  if (!ghPath) {
    const direct = await exec("gh", ["--version"]).catch(() => null);
    if (direct?.code === 0) ghPath = "gh";
    else {
      const r = await exec("sh", ["-c", 'exec "${SHELL:-/bin/sh}" -lic "command -v gh" </dev/null']).catch(() => null);
      const p = r?.stdout?.trim().split("\n").pop();
      if (!p) throw new Error("gh bulunamadı. GitHub CLI'ı kurup `gh auth login` ile giriş yapın.");
      ghPath = p;
    }
  }
  return exec(ghPath, args, { timeout: 30000 });
}

// Linear eklentisinin aracı ve çalışma alanı; yoksa başlıksız çalışılır.
async function linearSetup() {
  const r = await exec("sh", ["-c", 'ls -d "$HOME"/.local/share/herdr-linear/app/*/herdr-linear 2>/dev/null | sort -V | tail -1']).catch(() => null);
  const bin = r?.stdout?.trim();
  if (!bin) return null;
  const cache = await readTextFile(appHome() + "/linear-cache.json").then(JSON.parse).catch(() => null);
  const ws = cache?.workspaces?.[0];
  return ws?.id ? { bin, ws: ws.id, url: ws.urlKey ? `https://linear.app/${ws.urlKey}/issue/` : null } : null;
}

export default class Previews extends View {
  init(_props, cx) {
    this.groups = null;
    this.error = "";
    this.loading = false;
    this.fetchedAt = null;
    this.confirm = null;
    this.sending = new Set();
    this.sendError = {};
    this.titles = {};
    try { this.titles = JSON.parse(localStorage.getItem("issueTitles") ?? "{}"); } catch {}
    this.titleMiss = new Set();
    this.showMerged = false;
    try { this.showMerged = localStorage.getItem("showMerged") === "1"; } catch {}
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await gh(["api", "graphql", "-f", "query=" + query()]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "gh hatası").trim());
        const d = JSON.parse(r.stdout).data;
        this.groups = groupPrs([...d.open.nodes, ...d.merged.nodes]);
        this.loadTitles(cx);
        this.error = "";
        this.fetchedAt = new Date().toISOString();
      } catch (e) {
        this.error = String(e.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  loadTitles(cx) {
    const keys = (this.groups ?? []).map((g) => g.key).filter((k) => k.startsWith("MAD-") && !this.titles[k] && !this.titleMiss.has(k));
    if (!keys.length) return;
    cx.spawn(async (cx) => {
      if (this.linear === undefined) this.linear = await linearSetup();
      if (!this.linear) return;
      for (const k of keys) {
        try {
          const r = await exec(this.linear.bin, ["app", JSON.stringify({ op: "find", key: k, workspace: this.linear.ws })], { timeout: 15000 });
          const is = (JSON.parse(r.stdout).issues ?? []).find((i) => i.identifier === k);
          if (is?.title) this.titles[k] = cleanTitle(is.title); else this.titleMiss.add(k);
        } catch { this.titleMiss.add(k); }
        cx.notify();
      }
      try { localStorage.setItem("issueTitles", JSON.stringify(this.titles)); } catch {}
    });
  }

  key(pr) { return pr.repo + "#" + pr.number; }

  request(pr, cx) {
    const k = this.key(pr);
    if (this.sending.has(k)) return;
    if (this.confirm?.key !== k || Date.now() - this.confirm.at > CONFIRM_MS) {
      this.confirm = { key: k, at: Date.now() };
      cx.timer.after(CONFIRM_MS + 50, (cx) => cx.notify());
      cx.notify();
      return;
    }
    this.confirm = null;
    this.sending.add(k);
    delete this.sendError[k];
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await gh(["pr", "comment", String(pr.number), "-R", ORG + "/" + pr.repo, "--body", TRIGGER]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "gh hatası").trim());
        pr.preview = { ...pr.preview, state: "building", since: new Date().toISOString(), url: null, run: null };
      } catch (e) {
        this.sendError[k] = String(e.message ?? e);
      }
      this.sending.delete(k);
      cx.notify();
      cx.timer.after(15000, (cx) => this.refresh(cx));
    });
  }

  open(url) { if (url) exec("open", [url]); }

  link(t, id, label, url) {
    return div().id(id).px(7).py(2).rounded(5).text_size(11.5).text_color(t.accent).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip(url).on_click((_e, cx) => { cx.stop_propagation(); this.open(url); }).child(label);
  }

  status(t, pr) {
    const p = pr.preview;
    const dot = (c) => div().size(7).flex_none().rounded(4).bg(c);
    const line = (el, text, color) => h_flex().gap(6).items_center().text_size(11.5).text_color(color).child(el).child(div().truncate().child(text));
    if (this.sending.has(this.key(pr))) return line(svg("mods/madlen-chrome/spinner.svg").size(11).text_color(t.working).spin(900), "Gönderiliyor…", t.working);
    switch (p.state) {
      case "building": return line(svg("mods/madlen-chrome/spinner.svg").size(11).text_color(t.working).spin(900), "Preview kuruluyor · " + ago(p.since), t.working);
      case "ready": return line(dot(t.done), "Preview hazır · " + ago(p.since), t.done);
      case "failed": return line(dot(t.blocked), "Preview başarısız · " + ago(p.since), t.blocked);
      default: return line(dot(t.idle), "Henüz preview alınmadı", t.dim);
    }
  }

  row(t, pr) {
    const k = this.key(pr);
    const confirming = this.confirm?.key === k && Date.now() - this.confirm.at <= CONFIRM_MS;
    const busy = this.sending.has(k) || pr.preview.state === "building";
    const p = pr.preview;
    return v_flex().id("pr-" + k).gap(5).px(10).py(8).rounded(8).bg(t.surface).border(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().id("st-" + k).flex_none().tooltip(pr.merged ? "Merge edildi · " + ago(pr.mergedAt).replace(/^(\d.*)$/, "$1 önce") : pr.draft ? "Taslak PR" : "Açık PR").child(svg(pr.merged ? "mods/madlen-previews/pr-merged.svg" : pr.draft ? "mods/madlen-previews/pr-draft.svg" : "mods/madlen-previews/pr-open.svg").size(13).text_color(pr.merged ? "#a371f7" : pr.draft ? "#8b949e" : "#3fb950")))
        .child(div().flex_none().px(6).py(1).rounded(4).bg(t.raised).text_size(10.5).font_semibold().text_color(t.muted).child(repoLabel(pr.repo)))
        .child(div().id("num-" + k).flex_none().text_size(12).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.accent)).tooltip("PR'ı aç").on_click(() => this.open(pr.url)).child("#" + pr.number))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).tooltip(pr.title).child(pr.title)))
      .when(canPreview(pr.repo) && !pr.merged, (e) => e.child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).child(this.status(t, pr)))
        .when(Boolean(p.url ?? p.lastUrl), (e) => e.child(this.link(t, "open-" + k, p.state === "ready" ? "Aç" : "Son preview", p.url ?? p.lastUrl)))
        .when(p.state === "failed" && Boolean(p.run), (e) => e.child(this.link(t, "run-" + k, "Hata", p.run)))
        .child(div().id("req-" + k).flex_none().px(9).py(3).rounded(6).text_size(11.5).font_medium().cursor_pointer()
          .bg(confirming ? t.solid : t.hover).text_color(confirming ? t.solid_foreground : busy ? t.dim : t.foreground)
          .hover((s) => s.bg(confirming ? t.solid : t.selected))
          .tooltip(confirming ? "Tekrar tıklayınca PR'a `" + TRIGGER + "` yazılır" : busy ? "Preview zaten kuruluyor; yine de yeniden alabilirsin" : "Bu PR için preview al")
          .on_click((_e, cx) => { cx.stop_propagation(); this.request(pr, cx); })
          .child(confirming ? "Gönder?" : "Preview al"))))
      .when(Boolean(this.sendError[k]), (e) => e.child(div().text_size(11).text_color(t.blocked).child(this.sendError[k])));
  }

  render() {
    const t = theme();
    const groups = (this.groups ?? []).map((g) => this.showMerged ? g : { ...g, prs: g.prs.filter((p) => !p.merged) }).filter((g) => g.prs.length);
    const seg = (id, label, on, value) => div().id(id).px(8).py(2).rounded(5).text_size(11).cursor_pointer()
      .bg(on ? t.surface : t.hover).text_color(on ? t.accent : t.muted).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.showMerged = value; try { localStorage.setItem("showMerged", value ? "1" : "0"); } catch {} cx.notify(); })
      .child(label);
    return v_flex().id("previews-root").size_full().bg(t.chrome).font_family("Helvetica Neue")
      .child(h_flex().flex_none().h(44).px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("PR'lar"))
        .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(this.loading ? "Yenileniyor…" : this.fetchedAt ? "Güncellendi · " + ago(this.fetchedAt) : ""))
        .child(h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.hover)
          .child(seg("f-open", "Açık", !this.showMerged, false))
          .child(seg("f-all", "Hepsi", this.showMerged, true)))
        .child(div().id("previews-refresh").px(8).py(3).rounded(6).text_size(11.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.refresh(cx)).child("Yenile")))
      .when(Boolean(this.error), (e) => e.child(div().flex_none().m(10).p(10).rounded(8).bg(t.blocked + "22").text_size(11.5).text_color(t.blocked).child("GitHub okunamadı: " + this.error)))
      .child(v_flex().id("previews-list").flex_1().min_h(0).overflow_y_scrollbar().px(10).py(10).gap(14)
        .when(!this.groups && !this.error, (e) => e.child(div().text_size(12).text_color(t.dim).child("PR'lar yükleniyor…")))
        .when(Boolean(this.groups) && !groups.length, (e) => e.child(div().text_size(12).text_color(t.dim).child("Açık PR'ın yok.")))
        .children(groups.map((g) => v_flex().id("g-" + g.key).gap(6)
          .child(h_flex().id("gh-" + g.key).px(2).gap(6).items_center().min_w(0)
            .when(g.key.startsWith("MAD-") && Boolean(this.linear?.url), (e) => e.cursor_pointer().hover((s) => s.opacity(0.8)).tooltip(this.titles[g.key] ? g.key + " · " + this.titles[g.key] : "Linear'da aç").on_click(() => this.open(this.linear.url + g.key)))
            .child(div().flex_none().text_size(11).font_semibold().text_color(t.dim).child(g.key))
            .when(Boolean(this.titles[g.key]), (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(this.titles[g.key]))))
          .children(g.prs.map((pr) => this.row(t, pr))))));
  }
}
