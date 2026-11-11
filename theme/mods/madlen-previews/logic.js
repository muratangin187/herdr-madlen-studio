// PR'lar panelinin saf mantığı: GitHub sorgusu, preview durumu, Linear numarasına göre gruplama.
export const ORG = "madlenio";
export const REPOS = ["madlen-deploy-api", "madlen-teacher", "madlen-exam"];
export const REPO_LABEL = { "madlen-deploy-api": "API", "madlen-teacher": "Teacher", "madlen-exam": "Exam" };
export const TRIGGER = "@madlen-agent deploy";
export const MERGED_DAYS = 7;
// Reviewer listesinde gösterilmeyen ortak/bot hesaplar.
export const NOT_REVIEWERS = ["devmadlen"];

export const canPreview = (repo) => REPOS.includes(repo);
export const repoLabel = (repo) => REPO_LABEL[repo] ?? repo.replace(/^madlen-/, "");

const FIELDS = `nodes { ... on PullRequest { number title url isDraft merged mergedAt headRefName updatedAt repository { name }
    comments(last: 40) { nodes { author { login } body createdAt } }
    reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } } } }
    latestReviews(first: 10) { nodes { author { login } state } } } }`;

export function query(now = Date.now()) {
  const since = new Date(now - MERGED_DAYS * 86400000).toISOString().slice(0, 10);
  return `query { open: search(query: "is:pr is:open author:@me org:${ORG}", type: ISSUE, first: 100) { ${FIELDS} }
    merged: search(query: "is:pr is:merged author:@me org:${ORG} merged:>=${since}", type: ISSUE, first: 100) { ${FIELDS} } }`;
}

const BOTS = new Set(["madlen-agent", "github-actions"]);
const isTrigger = (c) => /^\s*@madlen-agent\s+deploy\b/i.test(c.body ?? "");
const previewUrl = (body) => (body.match(/https:\/\/[\w.-]+\.preview\.madlen\.io/) ?? [])[0] ?? null;
const runUrl = (body) => (body.match(/https:\/\/github\.com\/[^\s)]+\/actions\/runs\/\d+/) ?? [])[0] ?? null;

function classify(body) {
  if (/GitHub Agent OTA/i.test(body)) return null;
  if (/preview ready|deployment succeeded/i.test(body)) return "ready";
  if (/preview failed|deployment failed|\bfailed\b|başarısız/i.test(body)) return "failed";
  if (/build started|preview|deployment|hazırlanıyor|sırada|queued/i.test(body)) return "building";
  return null;
}

// state: none | building | ready | failed. since: son preview isteğinin zamanı.
export function previewStatus(comments) {
  let lastUrl = null;
  let idx = -1;
  comments.forEach((c, i) => {
    if (isTrigger(c)) idx = i;
    if (BOTS.has(c.author?.login) && classify(c.body ?? "") === "ready") lastUrl = previewUrl(c.body) ?? lastUrl;
  });
  if (idx < 0) return { state: "none", lastUrl };
  let state = "building", url = null, run = null;
  for (const c of comments.slice(idx + 1)) {
    if (!BOTS.has(c.author?.login)) continue;
    const k = classify(c.body ?? "");
    if (!k) continue;
    state = k;
    url = previewUrl(c.body) ?? url;
    run = runUrl(c.body) ?? run;
  }
  return { state, since: comments[idx].createdAt, url: state === "ready" ? url ?? lastUrl : null, run, lastUrl };
}

// login -> requested | APPROVED | CHANGES_REQUESTED | COMMENTED; yeniden istenen review "requested" sayılır.
export function reviewersOf(n) {
  const out = {};
  for (const r of n.latestReviews?.nodes ?? []) if (r.author?.login && r.state !== "PENDING") out[r.author.login] = r.state;
  for (const r of n.reviewRequests?.nodes ?? []) if (r.requestedReviewer?.login) out[r.requestedReviewer.login] = "requested";
  return out;
}

// Organizasyon üyeleri: kendin ve ortak hesaplar hariç, PR'larında en çok reviewer olanlar önce.
export function rankMembers(members, groups, me) {
  const count = {};
  for (const g of groups ?? []) for (const pr of g.prs) for (const login of Object.keys(pr.reviewers ?? {})) count[login] = (count[login] ?? 0) + 1;
  return members.filter((m) => m !== me && !NOT_REVIEWERS.includes(m))
    .sort((a, b) => (count[b] ?? 0) - (count[a] ?? 0) || a.localeCompare(b));
}

export const previewHost = (url) => (url ?? "").replace(/^https?:\/\//, "");

export function issueKey(pr) {
  const m = (pr.headRefName + " " + pr.title).match(/mad-(\d+)/i);
  return m ? "MAD-" + m[1] : "Diğer";
}

// Açık PR'lar önce, sonra merge edilenler; her birinde önce preview alınabilen repolar.
export function groupPrs(nodes) {
  const groups = new Map();
  const seen = new Set();
  for (const n of nodes) {
    if (!n?.number || seen.has(n.url)) continue;
    seen.add(n.url);
    const pr = { repo: n.repository.name, number: n.number, title: n.title, url: n.url, draft: n.isDraft,
      merged: Boolean(n.merged), mergedAt: n.mergedAt, branch: n.headRefName, updatedAt: n.mergedAt ?? n.updatedAt,
      preview: previewStatus(n.comments?.nodes ?? []), reviewers: reviewersOf(n) };
    const key = issueKey(n);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pr);
  }
  const order = (pr) => (pr.merged ? "1" : "0") + (canPreview(pr.repo) ? String(REPOS.indexOf(pr.repo)) : "9" + pr.repo);
  return [...groups.entries()]
    .map(([key, prs]) => ({ key, prs: prs.sort((a, b) => order(a).localeCompare(order(b))),
      updatedAt: prs.map((p) => p.updatedAt).sort().at(-1) }))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

// PR başlığının başındaki issue numaraları ("MAD-9340:", "MAD-8386/MAD-7243 -") grup başlığında zaten var.
export const shortTitle = (t) => t.replace(/^\s*(\[?MAD-\d+\]?[\s/,+&]*)+[:\-–]?\s*/i, "").trim() || t;

export const cleanTitle = (t) => t.replace(/^\s*(\[[^\]]*\]\s*)+/, "").trim();

export function ago(iso, now = Date.now()) {
  if (!iso) return "";
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (m < 1) return "az önce";
  if (m < 60) return m + " dk";
  const h = Math.round(m / 60);
  return h < 24 ? h + " sa" : Math.round(h / 24) + " gün";
}
