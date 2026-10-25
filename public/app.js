const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "short" }) : "";
const today = new Date().toISOString().slice(0, 10);

function who(email) {
  if (!email || email === "both") return "ambos";
  return email.split("@")[0];
}

function taskItem(t) {
  const late = t.status === "open" && t.due_date && t.due_date < today;
  const due = t.due_date ? `<span class="${late ? "late" : ""}">📅 ${fmtDate(t.due_date)}</span> · ` : "";
  return `<li>
    <input type="checkbox" data-id="${t.id}" ${t.status === "done" ? "checked" : ""} aria-label="Completar">
    <div>
      <div>${esc(t.title)}</div>
      <div class="meta">${due}${esc(t.topic_icon || "")} ${esc(t.topic_name || "")} · ${esc(who(t.assignee))}
        ${t.notes ? `<br>${esc(t.notes)}` : ""}
        ${t.completed_at ? `<br>✔ ${esc(t.completed_at.slice(0, 10))} por ${esc(who(t.completed_by))}` : ""}</div>
    </div>
  </li>`;
}

async function loadTasks(status) {
  const list = $(status === "open" ? "open-list" : "done-list");
  const tasks = await api(`/api/tasks?status=${status}`);
  list.innerHTML = tasks.length ? tasks.map(taskItem).join("") : `<li class="empty">Nada por aquí 🎉</li>`;
}

async function loadTopics() {
  const topics = await api("/api/topics");
  $("topics").innerHTML = topics.map((t) => `<div class="topic">
      <h3>${esc(t.icon || "")} ${esc(t.name)}</h3>
      <p>${esc(t.status_summary || "Sin estado todavía")}</p>
    </div>`).join("");
  $("email-topic").innerHTML = `<option value="">— Ninguno —</option>` +
    topics.map((t) => `<option value="${esc(t.slug)}">${esc(t.icon || "")} ${esc(t.name)}</option>`).join("");
}

// Completar / reabrir
document.addEventListener("change", async (e) => {
  const cb = e.target;
  if (!cb.matches("input[type=checkbox][data-id]")) return;
  await api(`/api/tasks/${cb.dataset.id}`, { method: "PATCH", body: JSON.stringify({ status: cb.checked ? "done" : "open" }) });
  loadTasks("open"); loadTasks("done");
});

// Entrada rápida
$("quick").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("quick-text").value.trim();
  if (!text) return;
  const btn = $("quick-btn"); btn.disabled = true; btn.textContent = "…";
  try {
    const r = await api("/api/inbox", { method: "POST", body: JSON.stringify({ text }) });
    $("quick-text").value = "";
    $("quick-result").hidden = false;
    $("quick-result").textContent = r.kind === "task"
      ? `✔ Tarea: «${r.title}» → ${r.topic_slug}${r.due_date ? ", " + fmtDate(r.due_date) : ""}`
      : `✔ Nota guardada en ${r.topic_slug}`;
    loadTasks("open"); loadTopics();
  } catch (err) {
    $("quick-result").hidden = false; $("quick-result").textContent = "⚠ " + err.message;
  } finally { btn.disabled = false; btn.textContent = "Añadir"; }
});

// Email en alemán
$("email-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("email-btn"); btn.disabled = true; btn.textContent = "Redactando…";
  try {
    const { draft } = await api("/api/draft-email", {
      method: "POST",
      body: JSON.stringify({ request: $("email-request").value, topic_slug: $("email-topic").value }),
    });
    $("email-draft").textContent = draft; $("email-draft").hidden = false; $("email-copy").hidden = false;
  } catch (err) {
    $("email-draft").textContent = "⚠ " + err.message; $("email-draft").hidden = false;
  } finally { btn.disabled = false; btn.textContent = "Redactar en alemán"; }
});
$("email-copy").addEventListener("click", () => navigator.clipboard.writeText($("email-draft").textContent.split("\n---")[0]));

// Pestañas
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll("main section").forEach((s) => (s.hidden = s.id !== "tab-" + b.dataset.tab));
}));

// Inicio
(async () => {
  try {
    const me = await api("/api/me");
    $("me").textContent = me.email;
    await Promise.all([loadTasks("open"), loadTasks("done"), loadTopics()]);
  } catch (err) {
    document.querySelector("main").innerHTML = `<p class="empty">⚠ ${esc(err.message)}</p>`;
  }
})();
