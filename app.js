/* Job Hunt dashboard.
   Talks straight to the database over HTTPS (Neon's SQL-over-HTTP endpoint). The password you type
   is the password of a limited database account that can only read jobs and change their status,
   notes and the settings. Nothing secret is stored in this file. */
"use strict";

const CFG = window.JOBHUNT || {};
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const SQL_URL = LOCAL ? "/sql" : `https://${CFG.host}/sql`;
const KEY = "jobhunt.conn";
let CONN = sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || "";
let SETTINGS = {};

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? esc(u) : "#");
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const ago = (iso) => {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (isNaN(d)) return "";
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
};

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 2600);
}

async function sql(query, params = []) {
  const res = await fetch(SQL_URL, {
    method: "POST",
    // No Content-Type header on purpose: Neon only allows its own headers from browsers (CORS).
    headers: { "Neon-Connection-String": CONN },
    body: JSON.stringify({ query, params }),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(text.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return (await res.json()).rows || [];
}

/* ---------- login ---------- */

function connString(password) {
  return `postgresql://${encodeURIComponent(CFG.role)}:${encodeURIComponent(password)}@${CFG.host}/${CFG.database}?sslmode=require`;
}

async function login(e) {
  e.preventDefault();
  const pw = $("#password").value;
  $("#login-error").textContent = "";
  CONN = connString(pw);
  try {
    await sql("SELECT 1 AS ok");
    (($("#remember").checked) ? localStorage : sessionStorage).setItem(KEY, CONN);
    $("#password").value = "";
    $("#password").type = "password";
    start();
  } catch (err) {
    CONN = "";
    $("#login-error").textContent = /password|auth/i.test(err.message) ? "Wrong password." : "Could not connect: " + err.message.slice(0, 120);
  }
}

function logout() {
  localStorage.removeItem(KEY);
  sessionStorage.removeItem(KEY);
  CONN = "";
  location.reload();
}

/* ---------- tabs ---------- */

const LOADERS = {
  overview: loadOverview, queue: loadQueue, needs: loadNeeds, questions: loadQuestions, tracking: loadTracking, interviews: loadInterviews,
  filtered: loadFiltered, cvs: loadCVs, settings: loadSettings,
};

function showTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("hidden", s.id !== "tab-" + name));
  if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
  LOADERS[name]().catch(handleError);
}

function handleError(err) {
  if (err.status === 401 || err.status === 403 || /password authentication/i.test(err.message)) return logout();
  toast("Error: " + err.message.slice(0, 140));
  console.error(err);
}

/* ---------- overview ---------- */

async function loadOverview() {
  const [counts, runs] = await Promise.all([
    sql("SELECT status, category, COUNT(*) AS n FROM jobs GROUP BY status, category"),
    sql("SELECT kind, started_at, finished_at, ok, summary FROM runs ORDER BY started_at DESC LIMIT 8"),
    loadSettingsData(),
  ]);
  const c = (pred) => counts.filter(pred).reduce((a, r) => a + Number(r.n), 0);
  const stats = [
    ["In queue", c((r) => r.status === "new"), "queue"],
    ["Internships in queue", c((r) => r.status === "new" && r.category === "internship"), "queue"],
    ["Applied ✅", c((r) => ["applied", "interview", "offer", "declined"].includes(r.status)), "tracking:applied"],
    ["Ready, sending next run", c((r) => r.status === "ready"), "tracking:ready"],
    ["Applying soon", c((r) => ["approved", "applying"].includes(r.status)), "tracking:approved,applying"],
    ["Need you", c((r) => r.status === "failed"), "tracking"],
    ["Interviews", c((r) => r.status === "interview"), "interviews"],
  ];
  $("#stats").innerHTML = stats.map(([label, n, tab]) =>
    `<button class="stat" data-go="${tab}" style="text-align:left;cursor:pointer"><b>${n}</b><span>${esc(label)}</span></button>`).join("");
  $("#stats").querySelectorAll("[data-go]").forEach((b) => b.onclick = () => {
    const [tab, filter] = b.dataset.go.split(":");
    if (filter) $("#t-status").value = filter;
    showTab(tab);
  });

  $("#runs").innerHTML = runs.length ? runs.map((r) => {
    let s = {};
    try { s = JSON.parse(r.summary || "{}"); } catch (_) {}
    const parts = [];
    if (s.found != null) parts.push(`found ${s.found}, kept ${s.new_kept} new (${s.kept_internships} internships, ${s.kept_remote_jobs} remote)`);
    if (s.tried != null) parts.push(`${s.live ? "submitted" : "test mode"}: tried ${s.tried}, applied ${s.applied}, ready ${s.ready}, need answers ${s.needs_answers}, problems ${s.failed}`);
    if (s.errors && Object.keys(s.errors).length) parts.push(`⚠ errors: ${Object.keys(s.errors).join(", ")}`);
    if (s.note) parts.push(s.note);
    return `<div class="card run">${r.ok ? "✅" : "⚠️"} <b>${esc(r.kind)}</b> · ${esc(ago(r.started_at))}<br><span class="muted">${esc(parts.join(" · "))}</span></div>`;
  }).join("") : `<div class="empty">No runs yet. The job finder runs automatically twice a day.</div>`;
}

/* ---------- job cards ---------- */

const STATUS_LABEL = {
  new: "In queue", prepared: "Ready for you (Internshala)", approved: "Applying soon", ready: "Ready (test mode)", closed: "Job closed", applying: "Applying…", applied: "Applied", failed: "Auto-apply failed",
  interview: "Interview", offer: "Offer 🎉", declined: "Company said no", rejected: "Skipped",
};
const TYPES = [["internship", "🎓 Internships"], ["fulltime", "💼 Full-time"], ["parttime", "⏱ Part-time"],
               ["contract", "📄 Contract"], ["", "❔ Type not stated"]];
const TYPE_NAME = { internship: "Internship", fulltime: "Full-time", parttime: "Part-time", contract: "Contract", "": "Type not stated" };
const typeOf = (j) => (j.category === "internship" ? "internship" : (j.kind || ""));
function grouped(rows, render) {
  return TYPES.map(([k, title]) => {
    const g = rows.filter((j) => typeOf(j) === k);
    return g.length ? `<div class="group-h">${title} (${g.length})</div><div class="list">${g.map(render).join("")}</div>` : "";
  }).join("");
}
const CAN_AUTO = (j) => ["greenhouse", "lever", "ashby"].includes(j.ats);

function jobCard(j) {
  const score = Number(j.score) || 0;
  const tags = [`<span class="tag type">${esc(TYPE_NAME[typeOf(j)])}</span>`].concat([
    j.category === "internship" ? ((j.location || "").toLowerCase().includes("work from home") ? "Work from home" : "") :
      j.category === "blr_office" ? "Bangalore office" : "Remote", `CV: ${j.variant}`, j.source,
  ].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`));
  if (j.salary) tags.unshift(`<span class="tag money">${esc(j.salary)}</span>`);
  if (CAN_AUTO(j)) tags.push(`<span class="tag auto">auto-apply possible</span>`);
  (j.flags || "").split(", ").filter(Boolean).forEach((f) => tags.push(`<span class="tag flag">${esc(f)}</span>`));

  const btn = (label, cls, act) => `<button class="btn small ${cls}" data-act="${act}">${label}</button>`;
  const actions = [`<a class="btn small" href="${safeUrl(j.apply_url || j.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>`];
  if (j.status === "new") {
    actions.push(btn(CAN_AUTO(j) ? "✅ Apply for me" : "✅ Approve", "good", "approved"));
    actions.push(btn("Mark applied", "", "applied"));
    actions.push(btn("✕ Skip", "bad", "rejected"));
  } else {
    if (j.status === "failed") actions.push(btn("↻ Try again", "good", "approved"));
    if (["approved", "failed", "applying", "ready"].includes(j.status)) actions.push(btn("Mark applied", "", "applied"));
    if (["applied", "approved"].includes(j.status)) actions.push(btn("🎤 Interview", "good", "interview"));
    if (["applied", "interview"].includes(j.status)) actions.push(btn("Company said no", "", "declined"));
    if (j.status === "interview") actions.push(btn("🎉 Offer", "good", "offer"));
    actions.push(btn("↺ Back to queue", "ghost", "new"));
  }
  actions.push(btn("Details", "ghost", "details"));

  return `<article class="job" data-id="${esc(j.id)}">
    <div class="job-head">
      <div class="score ${score >= 55 ? "hi" : score < 25 ? "lo" : ""}" title="match score">${score}</div>
      <div style="flex:1;min-width:0">
        <div class="job-title">${esc(j.title)}</div>
        <div class="job-meta">${esc(j.company)} · ${esc((j.location || "").slice(0, 90))} · found ${esc(ago(j.found_at))}
          ${j.status !== "new" ? ` · <b>${esc(STATUS_LABEL[j.status] || j.status)}</b> ${esc(ago(j.status_at))}` : ""}</div>
        <div class="tags">${tags.join("")}</div>
      </div>
    </div>
    <div class="actions">${actions.join("")}</div>
    <div class="extra hidden"></div>
  </article>`;
}

function wireCards(container, reload) {
  container.querySelectorAll(".job").forEach((card) => {
    const id = card.dataset.id;
    card.querySelectorAll("[data-act]").forEach((b) => b.onclick = async () => {
      const act = b.dataset.act;
      try {
        if (act === "details") return toggleDetails(card, id);
        const extra = act === "applied" ? ", applied_at = $3" : "";
        const params = act === "applied" ? [act, now(), now(), id] : [act, now(), id];
        await sql(`UPDATE jobs SET status = $1, status_at = $2${extra} WHERE id = $${params.length}`, params);
        toast({ approved: "Approved ✅", rejected: "Skipped", applied: "Marked as applied", interview: "Moved to interviews 🎤",
                offer: "Congratulations! 🎉", declined: "Noted", new: "Back in the queue" }[act] || "Saved");
        card.style.opacity = ".4";
        setTimeout(reload, 250);
      } catch (err) { handleError(err); }
    });
  });
}

async function toggleDetails(card, id) {
  const box = card.querySelector(".extra");
  if (!box.classList.contains("hidden")) return box.classList.add("hidden");
  const [r] = await sql("SELECT description, notes, apply_log FROM jobs WHERE id = $1", [id]);
  const shots = await sql("SELECT name FROM files WHERE name = $1", ["shot_" + id + ".jpg"]);
  box.innerHTML = `
    ${r.apply_log ? `<div class="desc"><b>Auto-apply log</b>\n${esc(r.apply_log.replace(/^NEEDS:.*\n/, ""))}</div>` : ""}
    ${shots.length ? `<button class="btn small" data-shot>Show the filled form</button><div class="shot-box"></div>` : ""}
    <div class="desc">${esc(r.description || "(no description saved)")}</div>
    <div class="notes"><textarea rows="2" placeholder="Your notes…">${esc(r.notes || "")}</textarea>
      <button class="btn small" style="margin-top:.3rem">Save note</button></div>`;
  box.classList.remove("hidden");
  const sb = box.querySelector("[data-shot]");
  if (sb) sb.onclick = async () => {
    const [f] = await sql("SELECT b64 FROM files WHERE name = $1", ["shot_" + id + ".jpg"]);
    box.querySelector(".shot-box").innerHTML = `<img class="shot" alt="filled form" src="data:image/jpeg;base64,${f.b64}">`;
    sb.remove();
  };
  box.querySelector(".notes button").onclick = async () => {
    await sql("UPDATE jobs SET notes = $1 WHERE id = $2", [box.querySelector("textarea").value, id]).catch(handleError);
    toast("Note saved");
  };
}

const JOB_FIELDS = "id, source, apply_log, company, title, location, kind, category, url, apply_url, ats, salary, found_at, score, variant, flags, status, status_at";

async function loadQueue() {
  const cat = $("#q-category").value;
  const type = $("#q-type").value;
  const sort = $("#q-sort").value === "new" ? "found_at DESC, score DESC" : "score DESC, found_at DESC";
  const words = $("#q-search").value.trim().toLowerCase();
  const params = ["new"];
  let where = "status = $1";
  if (cat) { params.push(cat); where += ` AND category = $${params.length}`; }
  if (type === "internship") where += " AND category = 'internship'";
  else if (type === "none") where += " AND category <> 'internship' AND (kind = '' OR kind IS NULL)";
  else if (type) { params.push(type); where += ` AND category <> 'internship' AND kind = $${params.length}`; }
  if (words) { params.push(`%${words}%`); where += ` AND (LOWER(title) LIKE $${params.length} OR LOWER(company) LIKE $${params.length} OR LOWER(description) LIKE $${params.length})`; }
  const rows = await sql(`SELECT ${JOB_FIELDS} FROM jobs WHERE ${where} ORDER BY ${sort} LIMIT 150`, params);
  const list = $("#queue-list");
  list.innerHTML = rows.length ? grouped(rows, jobCard) : `<div class="empty">Nothing in the queue. New jobs arrive twice a day.</div>`;
  wireCards(list, loadQueue);
}

async function loadTracking() {
  const statuses = $("#t-status").value.split(",");
  const ph = statuses.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await sql(`SELECT ${JOB_FIELDS} FROM jobs WHERE status IN (${ph}) ORDER BY status_at DESC LIMIT 300`, statuses);
  const list = $("#tracking-list");
  list.innerHTML = rows.length ? grouped(rows, jobCard) : `<div class="empty">Nothing here yet.</div>`;
  wireCards(list, loadTracking);
}

async function loadInterviews() {
  const [ivs, jobs] = await Promise.all([
    sql("SELECT company, title, starts_at, link, subject, sender, snippet, invite_sent FROM interviews ORDER BY starts_at DESC LIMIT 50"),
    sql(`SELECT ${JOB_FIELDS} FROM jobs WHERE status = 'interview' ORDER BY status_at DESC`),
  ]);
  const ivHtml = ivs.map((i) => `<div class="card"><b>${esc(i.company || i.sender)}</b> · ${esc(i.title || i.subject)}<br>
      <span class="muted">${i.starts_at ? "🗓 " + esc(new Date(i.starts_at).toLocaleString()) : "Time not found in the email"}
      ${Number(i.invite_sent) ? " · calendar invite sent" : ""}</span>
      ${i.link ? `<br><a href="${safeUrl(i.link)}" target="_blank" rel="noopener noreferrer">Meeting link ↗</a>` : ""}
      <div class="muted" style="font-size:.85rem;margin-top:.3rem">${esc(i.snippet || "")}</div></div>`).join("");
  $("#interview-list").innerHTML = (ivHtml + jobs.map(jobCard).join("")) ||
    `<div class="empty">No interviews yet. When an interview email arrives in Gmail, it shows up here and you get a calendar invite.</div>`;
  wireCards($("#interview-list"), loadInterviews);
}

async function loadFiltered() {
  const r = $("#f-reason").value;
  const rows = r
    ? await sql("SELECT source, company, title, location, url, reason, found_at FROM dropped WHERE reason LIKE $1 ORDER BY found_at DESC LIMIT 200", [`%${r}%`])
    : await sql("SELECT source, company, title, location, url, reason, found_at FROM dropped WHERE reason NOT LIKE 'not a tech%' AND reason NOT LIKE 'not remote%' ORDER BY found_at DESC LIMIT 200");
  $("#filtered-list").innerHTML = rows.length ? rows.map((d) => `<div class="job">
      <div class="job-title">${esc(d.title)}</div>
      <div class="job-meta">${esc(d.company)} · ${esc((d.location || "").slice(0, 70))} · ${esc(d.source)}</div>
      <div class="tags"><span class="tag flag">${esc(d.reason)}</span></div>
      <div class="actions"><a class="btn small" href="${safeUrl(d.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a></div>
    </div>`).join("") : `<div class="empty">Nothing filtered with that reason.</div>`;
}

async function loadNeeds() {
  const rows = await sql(`SELECT ${JOB_FIELDS} FROM jobs WHERE status = 'prepared'
      OR (status = 'failed' AND apply_log NOT LIKE 'NEEDS:%')
      OR (status = 'new' AND ats IN ('workday', '')) ORDER BY score DESC LIMIT 300`);
  const pending = await sql("SELECT COUNT(*) AS n FROM jobs WHERE status = 'new' AND ats IN ('internshala', 'linkedin')");
  const sections = [
    ["📝 Internshala: ready for you to submit", "The answers are written for you. Open the internship, tap Apply, paste them, Submit.",
      rows.filter((j) => j.status === "prepared" && j.ats === "internshala"), internshalaCard],
    ["🔗 LinkedIn Easy Apply", "Open it in the LinkedIn app, tap Easy Apply (it fills your profile), upload the CV named below if asked, paste answers, Submit.",
      rows.filter((j) => j.status === "prepared" && j.ats === "linkedin"), internshalaCard],
    ["🔒 CAPTCHA: just press Submit", "The form is filled up to the “I'm not a robot” check. Open it, tick it, Submit.",
      rows.filter((j) => j.status === "failed" && /^CAPTCHA/.test(j.apply_log || "")), jobCard],
    ["✉️ Needs the email code", "This site sends a security code to your email before it accepts an application. Open it, apply (every answer is in Details), and type the code from your email.",
      rows.filter((j) => j.status === "failed" && /^EMAIL CODE/.test(j.apply_log || "")), jobCard],
    ["🏢 Workday", "Big companies' hiring system: each company needs its own Workday account (email + password) before you can apply.",
      rows.filter((j) => j.status === "new" && j.ats === "workday"), jobCard],
    ["⚠️ Auto-apply problems", "The agent tried but something went wrong (details inside). Tap Try again or apply yourself.",
      rows.filter((j) => j.status === "failed" && !/^(CAPTCHA|EMAIL CODE)/.test(j.apply_log || "")), jobCard],
    ["🌐 Other sites", "Posted on job boards that link to the company's own site. The agent can't apply there yet.",
      rows.filter((j) => j.status === "new" && j.ats === ""), jobCard],
  ];
  const total = sections.slice(0, 4).reduce((a, s) => a + s[2].length, 0);
  const nb = $("#n-badge"); nb.textContent = total; nb.classList.toggle("hidden", !total);
  $("#needs-list").innerHTML = sections.map(([title, help, list, card]) => list.length ? `
      <h2 class="section-h">${title} (${list.length})</h2><p class="hint">${help}</p>${grouped(list, card)}` : "").join("")
    + (Number(pending[0].n) ? `<p class="hint">⏳ ${pending[0].n} more Internshala / LinkedIn applications are being prepared (a batch every hour).</p>` : "")
    || `<div class="empty">Nothing needs you right now. 🎉</div>`;
  $("#needs-list").querySelectorAll("[data-copy]").forEach((b) => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.closest(".job").querySelector(`[data-text="${b.dataset.copy}"]`).textContent); toast("Copied"); }
    catch (_) { toast("Long-press the text to copy it"); }
  });
  wireCards($("#needs-list"), loadNeeds);
}

function internshalaCard(j) {
  let p = {};
  try { p = JSON.parse((j.apply_log || "").replace(/^PREPARED:/, "")); } catch (_) {}
  return `<article class="job" data-id="${esc(j.id)}">
    <div class="job-title">${esc(j.title)}</div>
    <div class="job-meta">${esc(j.company)} · ${esc((j.location || "").slice(0, 60))} ${j.salary ? "· " + esc(j.salary) : ""}</div>
    <div class="actions"><a class="btn small primary" href="${safeUrl(j.url)}" target="_blank" rel="noopener noreferrer">1. Open on ${j.ats === "linkedin" ? "LinkedIn" : "Internshala"} ↗</a></div>
    ${p.cv ? `<div class="job-meta" style="margin-top:.5rem">CV to upload: <b>${esc(p.cv)}</b> (CVs tab)</div>` : ""}
    <div class="job-meta" style="margin-top:.6rem"><b>2. ${j.ats === "linkedin" ? "Cover note / “Why you?”" : "“Why should you be hired?”"}</b> <button class="btn small" data-copy="why">Copy</button></div>
    <div class="paste" data-text="why">${esc(p.why || "")}</div>
    <div class="job-meta" style="margin-top:.6rem"><b>Availability</b> <button class="btn small" data-copy="av">Copy</button></div>
    <div class="paste" data-text="av">${esc(p.availability || "")}</div>
    ${p.common ? `<div class="job-meta" style="margin-top:.6rem"><b>Common questions</b> <button class="btn small" data-copy="common">Copy</button></div>
      <div class="paste" data-text="common">${esc(p.common)}</div>` : ""}
    <div class="actions"><button class="btn small good" data-act="applied">3. ✅ I submitted it</button>
      <button class="btn small bad" data-act="rejected">✕ Skip</button></div>
  </article>`;
}

async function loadQuestions() {
  const rows = await sql("SELECT question, label, answer, example_job, options FROM answers ORDER BY (answer = '') DESC, asked_at DESC LIMIT 200");
  updateBadge(rows.filter((r) => !r.answer).length);
  const list = $("#questions-list");
  if (!rows.length) { list.innerHTML = `<div class="empty">No questions. The agent could answer everything so far. 🎉</div>`; return; }
  list.innerHTML = rows.map((r, i) => {
    let opts = [];
    try { opts = JSON.parse(r.options || "[]"); } catch (_) {}
    const chosen = (r.answer || "").split(" || ");
    return `<div class="job" data-i="${i}">
      <div class="job-title">${esc(r.label)}</div>
      <div class="job-meta">asked by ${esc(r.example_job)} ${r.answer ? "· ✅ answered" : "· ⏳ waiting for you"}</div>
      ${opts.length ? `<div class="chips">${opts.map((o) => `<button class="chip ${chosen.includes(o) ? "on" : ""}" data-opt="${esc(o)}">${esc(o)}</button>`).join("")}</div>
        <p class="hint">Tap one (or several if the question allows).</p>` : ""}
      <textarea rows="${opts.length ? 1 : 3}" placeholder="Your answer…">${esc(r.answer || "")}</textarea>
      <div class="actions"><button class="btn small primary" data-save>Save answer</button></div>
    </div>`;
  }).join("");
  list.querySelectorAll(".job").forEach((card) => {
    const r = rows[Number(card.dataset.i)];
    const ta = card.querySelector("textarea");
    card.querySelectorAll(".chip").forEach((c) => c.onclick = () => {
      c.classList.toggle("on");
      ta.value = Array.from(card.querySelectorAll(".chip.on")).map((x) => x.dataset.opt).join(" || ");
    });
    card.querySelector("[data-save]").onclick = async () => {
      try {
        await sql("UPDATE answers SET answer = $1, answered_at = $2 WHERE question = $3", [ta.value.trim(), now(), r.question]);
        toast("Saved. Waiting applications will go out within the hour.");
        loadQuestions();
      } catch (err) { handleError(err); }
    };
  });
}

function updateBadge(n) {
  const b = $("#q-badge");
  b.textContent = n;
  b.classList.toggle("hidden", !n);
}

async function loadCVs() {
  const rows = await sql("SELECT name, mime, updated_at FROM files ORDER BY name");
  $("#cv-list").innerHTML = rows.length ? rows.map((f) => `<div class="job"><div class="job-head">
      <div style="flex:1"><div class="job-title">${esc(f.name)}</div><div class="job-meta">updated ${esc(ago(f.updated_at))}</div></div>
      <button class="btn small" data-file="${esc(f.name)}">Download</button></div></div>`).join("")
    : `<div class="empty">CVs appear here after the first run.</div>`;
  $("#cv-list").querySelectorAll("[data-file]").forEach((b) => b.onclick = async () => {
    const [f] = await sql("SELECT mime, b64 FROM files WHERE name = $1", [b.dataset.file]);
    const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: f.mime }));
    const a = Object.assign(document.createElement("a"), { href: url, download: b.dataset.file });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}

/* ---------- settings ---------- */

async function loadSettingsData() {
  const rows = await sql("SELECT key, value FROM settings");
  SETTINGS = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const pill = $("#mode-pill");
  if (SETTINGS.paused === "1") { pill.textContent = "Paused"; pill.className = "pill bad"; }
  else if (SETTINGS.dry_run === "1") { pill.textContent = "Test mode"; pill.className = "pill warn"; }
  else { pill.textContent = "Live"; pill.className = "pill"; }
  return SETTINGS;
}

async function saveSetting(key, value) {
  await sql("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2", [key, String(value)]);
  SETTINGS[key] = String(value);
  await loadSettingsData();
  toast("Saved");
}

async function loadSettings() {
  await loadSettingsData();
  const sw = (key, title, help, invert = false) => {
    const on = (SETTINGS[key] === "1") !== invert;
    return `<div class="setting"><div><b>${title}</b><small>${help}</small></div>
      <label class="switch"><input type="checkbox" data-key="${key}" data-invert="${invert ? 1 : 0}" ${on ? "checked" : ""}><span></span></label></div>`;
  };
  const num = (key, title, help, min, max) => `<div class="setting"><div><b>${title}</b><small>${help}</small></div>
      <input type="number" min="${min}" max="${max}" data-num="${key}" value="${esc(SETTINGS[key])}"></div>`;
  let sources = {};
  try { sources = JSON.parse(SETTINGS.sources || "{}"); } catch (_) {}
  const srcNames = { remotive: "Remotive", remoteok: "RemoteOK", himalayas: "Himalayas", jobicy: "Jobicy", weworkremotely: "We Work Remotely",
    hn: "Hacker News: Who is hiring", ats: "Company career pages (Greenhouse/Lever/Ashby/Workable/Recruitee/SmartRecruiters)",
    internshala: "Internshala", linkedin: "LinkedIn (public listings, no login)" };

  $("#settings-form").innerHTML = `
    ${sw("paused", "Running", "Turn off to pause everything (finding and applying).", true)}
    ${sw("auto_apply", "Auto-apply", "On: applies by itself to every good match on Greenhouse/Lever/Ashby forms, no tap needed.")}
    ${sw("dry_run", "Test mode", "On: fills forms and takes screenshots but does NOT submit. Turn off when you're happy.")}
    ${num("daily_cap", "Max automatic applications per day", "Safety limit.", 0, 50)}
    ${num("auto_threshold", "Minimum match score for auto-apply", "Jobs below this wait in the queue for you.", 0, 100)}
    ${sw("remote_internships", "Also remote internships", "Off: internships only in Bangalore. On: also work-from-home internships open to India.")}
    ${sw("bangalore_office", "Also Bangalore office jobs", "On: full-time / part-time / contract jobs in Bangalore offices (not only remote).")}
    ${sw("tech_adjacent", "Also tech-adjacent roles", "On: technical support, QA/testing, analyst, technical writer, solutions/implementation roles.")}
    <div class="setting"><div><b>Run now</b><small>Ask the job finder to run at its next check (within the hour).</small></div>
      <button class="btn small primary" id="run-now">${SETTINGS.run_requested === "1" ? "Requested ✓" : "Run now"}</button></div>
    <h2>Sources</h2>
    ${Object.entries(srcNames).map(([k, label]) => `<div class="setting"><div>${esc(label)}</div>
      <label class="switch"><input type="checkbox" data-src="${k}" ${sources[k] !== false ? "checked" : ""}><span></span></label></div>`).join("")}
    <p class="hint">Never applied to, whatever the settings: anything asking you to pay, training-and-placement programmes, edtech or institutes, recruitment agencies, and unpaid internships.</p>`;

  const form = $("#settings-form");
  form.querySelectorAll("[data-key]").forEach((i) => i.onchange = () => {
    const on = i.checked !== (i.dataset.invert === "1");
    saveSetting(i.dataset.key, on ? "1" : "0").catch(handleError);
  });
  form.querySelectorAll("[data-num]").forEach((i) => i.onchange = () => saveSetting(i.dataset.num, Math.max(0, parseInt(i.value || "0", 10))).catch(handleError));
  form.querySelectorAll("[data-src]").forEach((i) => i.onchange = () => {
    sources[i.dataset.src] = i.checked;
    saveSetting("sources", JSON.stringify(sources)).catch(handleError);
  });
  $("#run-now").onclick = () => saveSetting("run_requested", "1").then(loadSettings).catch(handleError);
}

/* ---------- start ---------- */

function start() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  loadSettingsData().catch(handleError);
  sql("SELECT COUNT(*) AS n FROM jobs WHERE status = 'prepared' OR (status = 'failed' AND apply_log NOT LIKE 'NEEDS:%') OR (status = 'new' AND ats = 'workday')")
    .then((r) => { const b = $("#n-badge"); b.textContent = r[0].n; b.classList.toggle("hidden", !Number(r[0].n)); }).catch(() => {});
  sql("SELECT COUNT(*) AS n FROM answers WHERE answer = ''").then((r) => updateBadge(Number(r[0].n))).catch(() => {});
  const tab = location.hash.slice(1);
  showTab(LOADERS[tab] ? tab : "overview");
}

document.addEventListener("DOMContentLoaded", () => {
  $("#login-form").onsubmit = login;
  $("#show-pw").onclick = () => {
    const i = $("#password"), show = i.type === "password";
    i.type = show ? "text" : "password";
    $("#show-pw").textContent = show ? "Hide" : "Show";
    $("#show-pw").setAttribute("aria-label", show ? "Hide password" : "Show password");
    i.focus();
  };
  $("#logout").onclick = logout;
  window.addEventListener("hashchange", () => { const t = location.hash.slice(1); if (CONN && LOADERS[t]) showTab(t); });
  $("#tabs").querySelectorAll("button").forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  ["#q-category", "#q-type", "#q-sort"].forEach((s) => $(s).onchange = () => loadQueue().catch(handleError));
  let timer;
  $("#q-search").oninput = () => { clearTimeout(timer); timer = setTimeout(() => loadQueue().catch(handleError), 300); };
  $("#t-status").onchange = () => loadTracking().catch(handleError);
  $("#f-reason").onchange = () => loadFiltered().catch(handleError);
  if (CONN) sql("SELECT 1 AS ok").then(start).catch(() => { CONN = ""; $("#login").classList.remove("hidden"); });
  else $("#login").classList.remove("hidden");
});
