import assert from "node:assert";
import { previewStatus, groupPrs, issueKey, cleanTitle, shortTitle, query, canPreview, repoLabel, reviewersOf, rankMembers } from "./theme/mods/madlen-previews/logic.js";

const c = (login, body, createdAt = "2026-01-01T10:00:00Z") => ({ author: { login }, body, createdAt });
const me = (body, t) => c("someone", body, t);

assert.deepEqual(previewStatus([]), { state: "none", lastUrl: null });

let s = previewStatus([me("@madlen-agent deploy", "2026-01-01T10:00:00Z")]);
assert.equal(s.state, "building");
assert.equal(s.since, "2026-01-01T10:00:00Z");

s = previewStatus([
  me("@madlen-agent deploy"),
  c("madlen-agent", "### Backend preview\n\nBuild started: ... **https://mad-1-api.preview.madlen.io**"),
]);
assert.equal(s.state, "building", "Build started is not ready yet");

s = previewStatus([
  me("@madlen-agent deploy"),
  c("github-actions", "### Backend preview ready\n\n**https://mad-1-api.preview.madlen.io** — branch `x`"),
]);
assert.equal(s.state, "ready");
assert.equal(s.url, "https://mad-1-api.preview.madlen.io");

s = previewStatus([
  me("@madlen-agent deploy"),
  c("madlen-agent", "### GitHub Agent Deployment\n\nDeployment succeeded.\n\nPreview URL: [https://pr-7.preview.madlen.io](https://pr-7.preview.madlen.io)"),
  me("@madlen-agent deploy", "2026-01-02T10:00:00Z"),
  c("github-actions", "### Backend preview failed\n\nsee the [run](https://github.com/o/r/actions/runs/123)"),
]);
assert.equal(s.state, "failed", "the latest request decides");
assert.equal(s.run, "https://github.com/o/r/actions/runs/123");
assert.equal(s.lastUrl, "https://pr-7.preview.madlen.io", "earlier success stays reachable");

s = previewStatus([me("@madlen-agent deploy"), c("madlen-agent", "### GitHub Agent OTA\n\nOTA yayınlandı")]);
assert.equal(s.state, "building", "OTA messages are not web previews");

s = previewStatus([me("@madlen-agent deploy"), c("someone", "Deployment succeeded")]);
assert.equal(s.state, "building", "only the bots report results");

assert.equal(issueKey({ headRefName: "kaan/mad-42-x", title: "t" }), "MAD-42");
assert.equal(issueKey({ headRefName: "feature", title: "MAD-7: t" }), "MAD-7");
assert.equal(issueKey({ headRefName: "feature", title: "t" }), "Diğer");
assert.equal(cleanTitle("[Feature Request] [Bug] Başlık"), "Başlık");
assert.equal(shortTitle("MAD-9340: Belge okuyucusu"), "Belge okuyucusu");
assert.equal(shortTitle("MAD-8386/MAD-7243: Ortak düzeltme"), "Ortak düzeltme");
assert.equal(shortTitle("[TEST] MAD-1 Exam"), "[TEST] MAD-1 Exam", "only a leading issue key is trimmed");
assert.deepEqual(reviewersOf({ latestReviews: { nodes: [{ author: { login: "a" }, state: "APPROVED" }, { author: { login: "b" }, state: "COMMENTED" }] },
  reviewRequests: { nodes: [{ requestedReviewer: { login: "b" } }] } }), { a: "APPROVED", b: "requested" }, "a re-request wins over an old review");
assert.deepEqual(rankMembers(["me", "devmadlen", "z", "y", "x"], [{ prs: [{ reviewers: { y: "requested" } }, { reviewers: { y: "APPROVED", z: "requested" } }] }], "me"),
  ["y", "z", "x"], "self and shared accounts dropped, frequent reviewers first");
assert.ok(canPreview("madlen-teacher") && !canPreview("teacher-chat"));
assert.equal(repoLabel("madlen-deploy-api"), "API");
assert.equal(repoLabel("madlen-teacher-tools"), "teacher-tools");
assert.match(query(Date.parse("2026-01-10T00:00:00Z")), /merged:>=2026-01-03/);

const pr = (repo, number, extra = {}) => ({ number, title: "MAD-1: t", url: `https://x/${repo}/${number}`, isDraft: false,
  merged: false, headRefName: "kaan/mad-1-x", updatedAt: "2026-01-01T00:00:00Z", repository: { name: repo }, comments: { nodes: [] }, ...extra });
const groups = groupPrs([
  pr("teacher-chat", 5),
  pr("madlen-teacher", 3, { merged: true, mergedAt: "2026-01-05T00:00:00Z" }),
  pr("madlen-exam", 4),
  pr("madlen-deploy-api", 2),
  pr("madlen-deploy-api", 2),
  pr("madlen-teacher", 9, { headRefName: "kaan/mad-2-y", title: "t", updatedAt: "2026-01-02T00:00:00Z" }),
]);
assert.deepEqual(groups.map((g) => g.key), ["MAD-1", "MAD-2"], "most recently updated group first");
assert.deepEqual(groups[0].prs.map((p) => p.repo + "#" + p.number),
  ["madlen-deploy-api#2", "madlen-exam#4", "teacher-chat#5", "madlen-teacher#3"],
  "open before merged, preview repos first, duplicates dropped");

console.log("PASS: preview states, issue grouping, ordering, query window, titles, reviewers");
