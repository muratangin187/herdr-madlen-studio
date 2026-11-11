// PR'lar: madlenio'daki açık (ve son 7 günde merge edilen) PR'ların, Linear numarasına göre.
// API, Teacher ve Exam'de preview durumu; "Preview al" yalnızca iki tıklamayla o PR'a
// `@madlen-agent deploy` yorumu yazar. GitHub'a `gh` ile (kişinin kendi oturumu) bağlanır.
// Linear başlıkları isteğe bağlıdır: Linear eklentisinin herdr-linear aracı ve oturumu varsa okunur.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme, appHome, readTextFile, run } from "herdr";
import { ORG, query, TRIGGER, canPreview, repoLabel, groupPrs, ago, cleanTitle, rankMembers, previewHost, shortTitle } from "./logic.js";

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
    this.expanded = {};
    this.busyAction = {};
    this.members = null;
    this.me = null;
    this.menu = {};
    this.copied = null;
    try { this.showMerged = localStorage.getItem("showMerged") === "1"; } catch {}
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
    cx.spawn(async (cx) => { if (this.linear === undefined) this.linear = await linearSetup(); cx.notify(); });
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

  // İki tıklamalı onay: ilk tıklama işlemi işaretler, 5 saniye içinde ikincisi çalıştırır.
  confirmed(action, cx) {
    if (this.confirm?.key === action && Date.now() - this.confirm.at <= CONFIRM_MS) { this.confirm = null; return true; }
    this.confirm = { key: action, at: Date.now() };
    cx.timer.after(CONFIRM_MS + 50, (cx) => cx.notify());
    cx.notify();
    return false;
  }

  armed(action) { return this.confirm?.key === action && Date.now() - this.confirm.at <= CONFIRM_MS; }

  // Bir PR üzerinde gh komutu: aynı PR'da aynı anda tek işlem; bitince liste yenilenir.
  act(pr, action, args, cx, { onOk, refreshMs = 2500 } = {}) {
    const k = this.key(pr);
    if (this.sending.has(k) || !this.confirmed(action, cx)) return;
    this.sending.add(k);
    this.busyAction[k] = action;
    delete this.sendError[k];
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await gh(args);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "gh hatası").trim());
        onOk?.();
      } catch (e) {
        this.sendError[k] = String(e.message ?? e);
      }
      this.sending.delete(k);
      delete this.busyAction[k];
      cx.notify();
      cx.timer.after(refreshMs, (cx) => this.refresh(cx));
    });
  }

  request(pr, cx) {
    this.act(pr, "preview:" + this.key(pr), ["pr", "comment", String(pr.number), "-R", ORG + "/" + pr.repo, "--body", TRIGGER], cx, {
      refreshMs: 15000,
      onOk: () => { pr.preview = { ...pr.preview, state: "building", since: new Date().toISOString(), url: null, run: null }; },
    });
  }

  setDraft(pr, draft, cx) {
    this.act(pr, (draft ? "draft:" : "ready:") + this.key(pr),
      ["pr", "ready", String(pr.number), "-R", ORG + "/" + pr.repo, ...(draft ? ["--undo"] : [])], cx, { onOk: () => { pr.draft = draft; } });
  }

  reviewer(pr, login, add, cx) {
    this.act(pr, (add ? "add:" : "remove:") + login + ":" + this.key(pr),
      ["pr", "edit", String(pr.number), "-R", ORG + "/" + pr.repo, add ? "--add-reviewer" : "--remove-reviewer", login], cx, {
        onOk: () => { pr.reviewers = { ...pr.reviewers }; if (add) pr.reviewers[login] = "requested"; else delete pr.reviewers[login]; },
      });
  }

  loadMembers(cx) {
    if (this.members) return;
    this.members = [];
    cx.spawn(async (cx) => {
      try {
        const [m, u] = await Promise.all([gh(["api", `orgs/${ORG}/members?per_page=100`, "--jq", ".[].login"]), gh(["api", "user", "--jq", ".login"])]);
        this.members = m.code === 0 ? m.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
        this.me = u.code === 0 ? u.stdout.trim() : null;
      } catch { this.members = []; }
      cx.notify();
    });
  }

  open(url) { if (url) exec("open", [url]); }

  copy(url, id, cx) {
    if (!url) return;
    exec("sh", ["-c", 'printf %s "$1" | pbcopy', "sh", url]).catch(() => {});
    this.copied = id;
    cx.timer.after(1500, (cx) => { if (this.copied === id) { this.copied = null; cx.notify(); } });
    cx.notify();
  }

  copyButton(t, id, url) {
    const done = this.copied === id;
    return div().id(id).flex_none().p(3).rounded(4).cursor_pointer().text_color(done ? t.done : t.dim)
      .hover((s) => s.bg(t.hover).text_color(done ? t.done : t.foreground)).tooltip(done ? "Kopyalandı" : "Linki kopyala")
      .on_click((_e, cx) => { cx.stop_propagation(); this.copy(url, id, cx); })
      .child(done ? div().text_size(11).font_semibold().child("✓") : svg("mods/madlen-previews/copy.svg").size(12));
  }

  // Repo etiketi: grupta aynı repodan birden fazla PR varsa numarayla ayrılır.
  previewLabel(g, pr) {
    const same = g.prs.filter((p) => p.repo === pr.repo && !p.merged).length > 1;
    return repoLabel(pr.repo) + (same ? " #" + pr.number : "");
  }

  avatar(t, pr, login, state) {
    const mark = { requested: ["•", t.working, "review bekleniyor"], APPROVED: ["✓", t.done, "onayladı"],
      CHANGES_REQUESTED: ["✗", t.blocked, "değişiklik istedi"], COMMENTED: ["…", t.muted, "yorum yaptı"],
      DISMISSED: ["–", t.dim, "review geçersiz"] }[state] ?? ["•", t.dim, String(state).toLowerCase()];
    return div().id(`av-${this.key(pr)}-${login}`).relative().size(18).flex_none().rounded(9).bg(t.raised)
      .flex().items_center().justify_center().text_size(8.5).font_semibold().text_color(t.muted).tooltip(login + " · " + mark[2])
      .child(login.slice(0, 2).toLocaleUpperCase("tr"))
      .child(div().absolute().right(-3).bottom(-3).size(10).rounded(5).bg(t.surface).flex().items_center().justify_center()
        .text_size(8).font_semibold().text_color(mark[1]).child(mark[0]));
  }

  // Küçük işlem düğmesi; onay bekliyorsa vurgulu ve "?" ile biter.
  pill(t, id, label, action, onClick, { danger = false, tip } = {}) {
    const armed = this.armed(action);
    return div().id(id).flex_none().px(8).py(3).rounded(6).text_size(11.5).font_medium().cursor_pointer()
      .bg(armed ? (danger ? "#dc2626" : t.solid) : t.hover).text_color(armed ? (danger ? "#ffffff" : t.solid_foreground) : t.foreground)
      .hover((s) => s.bg(armed ? (danger ? "#dc2626" : t.solid) : t.selected))
      .when(Boolean(tip), (e) => e.tooltip(armed ? "Onaylamak için tekrar tıkla" : tip))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(armed ? label + "?" : label);
  }

  drawer(t, pr) {
    const k = this.key(pr);
    const requested = Object.keys(pr.reviewers ?? {});
    const members = rankMembers(this.members ?? [], this.groups, this.me);
    const label = (s) => div().text_size(10.5).font_semibold().text_color(t.dim).child(s);
    return v_flex().id("dr-" + k).mx(10).mb(8).mt(2).p(10).gap(8).rounded(8).bg(t.background).border(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().child(label(pr.draft ? "DURUM · TASLAK" : "DURUM · REVIEW'A HAZIR")))
        .child(pr.draft
          ? this.pill(t, "ready-" + k, "Review'a hazır", "ready:" + k, (cx) => this.setDraft(pr, false, cx), { tip: "PR taslaktan çıkar; reviewer'lara bildirim gider" })
          : this.pill(t, "draft-" + k, "Taslağa çevir", "draft:" + k, (cx) => this.setDraft(pr, true, cx), { tip: "PR taslağa döner" })))
      .child(label("REVIEWER"))
      .child(h_flex().flex_wrap().gap(5)
        .when(!this.members?.length, (e) => e.child(div().text_size(11).text_color(t.dim).child(this.members ? "Üye listesi alınamadı" : "Yükleniyor…")))
        .children(members.map((login) => {
          const on = requested.includes(login);
          return this.pill(t, `rvb-${k}-${login}`, (on ? "× " : "+ ") + login, (on ? "remove:" : "add:") + login + ":" + k,
            (cx) => this.reviewer(pr, login, !on, cx), { danger: on, tip: on ? "Review isteğini geri çek" : "Reviewer olarak ekle" });
        })))
      .when(Boolean(this.sendError[k]), (e) => e.child(div().text_size(11).text_color(t.blocked).child(this.sendError[k])));
  }

  row(t, pr, first) {
    const k = this.key(pr);
    const open = Boolean(this.expanded[k]) && !pr.merged;
    const toggle = (cx) => { if (pr.merged) return; this.expanded[k] = !open; if (!open) this.loadMembers(cx); cx.notify(); };
    const reviewers = pr.merged ? [] : Object.entries(pr.reviewers ?? {});
    return v_flex().id("r-" + k)
      .child(h_flex().id("rh-" + k).h(32).px(10).gap(7).items_center().when(!first, (e) => e.border_t(1).border_color(t.border))
        .bg(open ? t.raised : t.surface).when(!pr.merged, (e) => e.cursor_pointer().hover((s) => s.bg(t.raised)))
        .on_click((_e, cx) => toggle(cx))
        .child(div().id("st-" + k).w(14).flex_none().tooltip(pr.merged ? "Merge edildi · " + ago(pr.mergedAt).replace(/^(\d.*)$/, "$1 önce") : pr.draft ? "Taslak PR" : "Açık PR")
          .child(svg(pr.merged ? "mods/madlen-previews/pr-merged.svg" : pr.draft ? "mods/madlen-previews/pr-draft.svg" : "mods/madlen-previews/pr-open.svg").size(13).text_color(pr.merged ? "#a371f7" : pr.draft ? "#8b949e" : "#3fb950")))
        .child(div().w(60).flex_none().truncate().px(4).py(1).rounded(4).bg(t.raised).text_size(10.5).font_semibold().text_color(t.muted).tooltip(pr.repo).child(repoLabel(pr.repo)))
        .child(div().id("num-" + k).flex_none().text_size(11.5).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.accent)).tooltip("PR'ı GitHub'da aç")
          .on_click((_e, cx) => { cx.stop_propagation(); this.open(pr.url); }).child("#" + pr.number))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(pr.merged ? t.muted : t.foreground).tooltip(pr.title).child(shortTitle(pr.title)))
        .children(reviewers.map(([login, state]) => this.avatar(t, pr, login, state)))
        .when(!pr.merged, (e) => e.child(div().w(16).flex_none().text_size(13).font_semibold().text_color(open ? t.accent : t.dim).child("⋯"))))
      .when(open, (e) => e.child(this.drawer(t, pr)));
  }

  previewLine(t, g, pr) {
    const p = pr.preview, k = this.key(pr), label = this.previewLabel(g, pr);
    const dot = (c) => div().size(7).flex_none().rounded(4).bg(c);
    const spin = () => svg("mods/madlen-chrome/spinner.svg").size(10).flex_none().text_color(t.working).spin(900);
    const line = (id) => h_flex().id(id).h(22).gap(7).items_center().text_size(11.5);
    const name = div().w(56).flex_none().truncate().text_color(t.muted).child(label);
    const when = (s) => div().flex_none().text_size(10.5).text_color(t.dim).child(s);
    const gap = () => div().flex_1();
    const link = (url, color, text) => div().id("pl-" + k).flex_initial().min_w(0).truncate().text_color(color).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).tooltip(url).on_click((_e, cx) => { cx.stop_propagation(); this.open(url); }).child(text);
    if (this.busyAction[k]?.startsWith("preview:"))
      return line("pv-" + k).child(spin()).child(name).child(div().flex_1().text_color(t.working).child("istek gönderiliyor…"));
    switch (p.state) {
      case "ready":
        return line("pv-" + k).child(dot(t.done)).child(name).child(link(p.url, t.accent, previewHost(p.url) + " ↗")).child(this.copyButton(t, "cp-" + k, p.url)).child(gap()).child(when(ago(p.since)));
      case "building":
        return line("pv-" + k).child(spin()).child(name)
          .child(p.lastUrl ? link(p.lastUrl, t.dim, "kuruluyor · önceki: " + previewHost(p.lastUrl) + " ↗") : div().flex_1().text_color(t.working).child("kuruluyor…"))
          .when(Boolean(p.lastUrl), (e) => e.child(this.copyButton(t, "cp-" + k, p.lastUrl)))
          .child(gap()).child(when(ago(p.since)));
      case "failed":
        return line("pv-" + k).child(dot(t.blocked)).child(name)
          .child(p.lastUrl ? link(p.lastUrl, t.dim, previewHost(p.lastUrl) + " ↗") : div().flex_1().text_color(t.dim).child("çalışan preview yok"))
          .when(Boolean(p.lastUrl), (e) => e.child(this.copyButton(t, "cp-" + k, p.lastUrl)))
          .child(gap())
          .when(Boolean(p.run), (e) => e.child(div().id("pr-run-" + k).flex_none().px(5).rounded(4).text_size(10.5).text_color(t.blocked).cursor_pointer()
            .hover((s) => s.bg(t.hover)).tooltip("Hata veren çalışmayı aç").on_click((_e, cx) => { cx.stop_propagation(); this.open(p.run); }).child("hata")))
          .child(when(ago(p.since)));
      default:
        return line("pv-" + k).child(dot(t.idle)).child(name).child(div().flex_1().text_color(t.dim).child("henüz preview alınmadı"));
    }
  }

  strip(t, g, prs) {
    const open = Boolean(this.menu[g.key]);
    return v_flex().id("sp-" + g.key).px(10).pt(6).pb(8).gap(2).border_t(1).border_color(t.border).bg(t.background)
      .child(h_flex().h(22).items_center()
        .child(div().flex_1().text_size(10.5).font_semibold().text_color(t.dim).child("PREVIEW"))
        .child(div().id("pm-" + g.key).flex_none().px(8).py(2).rounded(6).text_size(11).font_medium().cursor_pointer()
          .bg(open ? t.selected : t.hover).text_color(open ? t.accent : t.foreground).hover((s) => s.bg(t.selected))
          .on_click((_e, cx) => { cx.stop_propagation(); this.menu[g.key] = !open; cx.notify(); })
          .child(open ? "Preview al ▴" : "Preview al ▾")))
      .children(prs.map((pr) => this.previewLine(t, g, pr)))
      .when(open, (e) => e.child(v_flex().mt(6).pt(6).gap(4).border_t(1).border_color(t.border).children(prs.map((pr) => {
        const k = this.key(pr);
        return v_flex().gap(2)
          .child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(this.previewLabel(g, pr) + " · #" + pr.number + " · " + shortTitle(pr.title)))
            .child(this.pill(t, "req-" + k, "Preview al", "preview:" + k, (cx) => this.request(pr, cx), { tip: "PR'a `" + TRIGGER + "` yazar" })))
          .when(Boolean(this.sendError[k]) && !this.expanded[k], (e) => e.child(div().text_size(11).text_color(t.blocked).child(this.sendError[k])));
      }))));
  }

  card(t, g) {
    const prs = this.showMerged ? g.prs : g.prs.filter((p) => !p.merged);
    const previewable = prs.filter((p) => canPreview(p.repo) && !p.merged);
    const title = this.titles[g.key];
    const linkable = g.key.startsWith("MAD-") && Boolean(this.linear?.url);
    return v_flex().id("c-" + g.key).rounded(9).overflow_hidden().bg(t.surface).border(1).border_color(t.border)
      .child(h_flex().id("ch-" + g.key).px(10).pt(8).pb(6).gap(6).items_center().min_w(0)
        .when(linkable, (e) => e.cursor_pointer().hover((s) => s.opacity(0.8)).tooltip(title ? g.key + " · " + title : "Linear'da aç").on_click(() => this.open(this.linear.url + g.key)))
        .child(div().flex_none().text_size(11).font_semibold().text_color(t.dim).child(g.key))
        .when(Boolean(title), (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(title))))
      .child(v_flex().border_t(1).border_color(t.border).children(prs.map((pr, i) => this.row(t, pr, i === 0))))
      .when(previewable.length > 0, (e) => e.child(this.strip(t, g, previewable)));
  }

  render() {
    const t = theme();
    const groups = (this.groups ?? []).filter((g) => this.showMerged || g.prs.some((p) => !p.merged));
    const seg = (id, label, on, value) => div().id(id).px(8).py(2).rounded(5).text_size(11).cursor_pointer()
      .bg(on ? t.surface : t.hover).text_color(on ? t.accent : t.muted).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.showMerged = value; try { localStorage.setItem("showMerged", value ? "1" : "0"); } catch {} cx.notify(); })
      .child(label);
    const icon = (id, tip, child, onClick) => div().id(id).flex_none().p(5).rounded(6).text_color(t.dim).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => onClick(cx)).child(child);
    return v_flex().id("previews-root").size_full().bg(t.chrome).font_family("Helvetica Neue")
      .child(h_flex().flex_none().h(40).pl(14).pr(6).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("PR'lar"))
        .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(this.loading ? "yenileniyor…" : this.fetchedAt ? ago(this.fetchedAt) : ""))
        .child(h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.hover)
          .child(seg("f-open", "Açık", !this.showMerged, false))
          .child(seg("f-all", "Hepsi", this.showMerged, true)))
        .child(icon("previews-refresh", "Yenile", this.loading ? svg("mods/madlen-chrome/spinner.svg").size(13).spin(900) : div().text_size(14).child("↻"), (cx) => this.refresh(cx)))
        .child(icon("previews-close", "Paneli kapat", div().text_size(13).child("✕"), () => run("layout.hide", { id: "panel" }))))
      .when(Boolean(this.error), (e) => e.child(div().flex_none().m(10).p(10).rounded(8).bg(t.blocked + "22").text_size(11.5).text_color(t.blocked).child("GitHub okunamadı: " + this.error)))
      .child(v_flex().id("previews-list").flex_1().min_h(0).overflow_y_scrollbar().px(10).py(10).gap(10)
        .when(!this.groups && !this.error, (e) => e.child(div().text_size(12).text_color(t.dim).child("PR'lar yükleniyor…")))
        .when(Boolean(this.groups) && !groups.length, (e) => e.child(div().text_size(12).text_color(t.dim).child("Açık PR'ın yok.")))
        .children(groups.map((g) => this.card(t, g))));
  }
}
