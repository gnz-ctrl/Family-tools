/* Family Hub — web. Todo el estado viene de /api/state; cada acción llama a la API y recarga. */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let S = null;                // estado completo
let currentTopic = null;     // slug del tema abierto
const uiOpen = {};           // desplegables abiertos
const drafts = {};           // borradores de email por tema

/* ---------- utilidades ---------- */
const todayISO = () => S?.today || new Date().toISOString().slice(0, 10);
const D = (d) => new Date(d + "T12:00:00");
const addDays = (n, from) => { const d = from ? D(from) : D(todayISO()); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const daysTo = (d) => Math.round((D(d) - D(todayISO())) / 864e5);
const fmt = (d) => D(d).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
const fmtLong = (d) => D(d).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
const eur = (n) => Number(n).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

async function api(path, opts = {}) {
  let res;
  try { res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } }); }
  catch { throw new Error("No hay conexión o la sesión ha caducado. Recarga la página."); }
  if (res.status === 401 || res.redirected) { location.reload(); throw new Error("Sesión caducada"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
const post = (path, body, method = "POST") => api(path, { method, body: JSON.stringify(body || {}) });

let flashTimer;
function say(text, error = false) {
  const f = $("flash"); f.hidden = false; f.textContent = text; f.classList.toggle("error", error);
  clearTimeout(flashTimer); if (!error) flashTimer = setTimeout(() => (f.hidden = true), 8000);
}
async function load() { S = await api("/api/state"); }
/** Ejecuta una acción, recarga el estado y pinta de nuevo. */
async function act(fn, ok) {
  try { const r = await fn(); await load(); renderAll(); if (ok) say(typeof ok === "function" ? ok(r) : ok); return r; }
  catch (e) { say("⚠ " + e.message, true); throw e; }
}

/* ---------- acceso a los datos ---------- */
const topicById = (id) => S.topics.find((t) => t.id === id);
const topicBySlug = (s) => S.topics.find((t) => t.slug === s);
const userName = (email) => email === "both" ? "Los dos" : (S.users.find((u) => u.email === email)?.name || (email || "").split("@")[0]);
const tName = (id) => topicById(id)?.name || "Sin tema";
function det(slug) {
  const t = topicBySlug(slug); const id = t?.id;
  return {
    t,
    facts: S.items.filter((i) => i.topic_id === id && i.kind === "fact"),
    contacts: S.items.filter((i) => i.topic_id === id && i.kind === "contact"),
    docs: S.items.filter((i) => i.topic_id === id && i.kind === "doc"),
    history: S.history.filter((h) => h.topic_id === id),
    mails: S.mails.filter((m) => m.topic_id === id),
    events: S.events.filter((e) => e.topic_id === id),
    open: S.tasks.filter((x) => x.topic_id === id && x.status === "open").sort(byDue),
  };
}
const byDue = (a, b) => (a.due_date || "9") < (b.due_date || "9") ? -1 : 1;

function dueBadge(d) {
  if (!d) return `<span class="badge mute">Sin fecha</span>`;
  const n = daysTo(d);
  if (n < 0) return `<span class="badge late">Vencida</span>`;
  if (n === 0) return `<span class="badge late">Hoy</span>`;
  if (n === 1) return `<span class="badge warn">Mañana</span>`;
  if (n <= 7) return `<span class="badge warn">${fmt(d)}</span>`;
  return `<span class="badge">${fmt(d)}</span>`;
}
const PANELS = { tasks: "Pendientes", mails: "Correos recibidos", events: "Eventos", gastos: "Gastos fijos y suscripciones", subs: "Suscripciones", trip: "Planear un viaje", facts: "Datos clave", mail: "Escribir un email", hist: "Historial", contacts: "Contactos" };
const fold = (key, summary, body, defOpen = false, id = "") => {
  const panel = key.split("-")[0];
  const x = currentTopic && PANELS[panel] ? `<button type="button" class="fold-x" data-hide-panel="${panel}" aria-label="Quitar panel" title="Quitar este panel">×</button>` : "";
  return `<details class="fold" data-fold="${key}" data-panel="${panel}" ${id ? `id="${id}"` : ""} ${(uiOpen[key] ?? defOpen) ? "open" : ""}>
  <summary>${summary}${x}<span class="chev" aria-hidden="true">▾</span></summary><div class="fold-body">${body}</div></details>`;
};
const hiddenOf = (t) => { try { return JSON.parse(t?.hidden || "[]"); } catch { return []; } };
let addingPanel = false, delPanel = null;
const foldTitle = (title, meta = "") => `<span class="fold-title">${title}</span>${meta ? `<span class="fold-meta">${meta}</span>` : ""}`;
let pendingTaskDel = null, creatingTopic = false, editingTopic = null, deletingTopic = null, editingTask = null, sharingTopic = null;
const COLORS = ["", "mint", "sky", "lilac", "peach", "sand", "rose", "sage", "slate"];
const COLOR_NAMES = { "": "Blanco", mint: "Menta", sky: "Cielo", lilac: "Lila", peach: "Melocotón", sand: "Arena", rose: "Rosa", sage: "Salvia", slate: "Pizarra" };
const otherUser = () => S.users.find((u) => u.email !== S.me);
const lock = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
/** Formulario para editar o mover una tarea */
const assistBusy = {}; // tareas a la espera de Claude
const parseAI = (t) => { try { return t.ai ? JSON.parse(t.ai) : null; } catch { return null; } };
const ACTION_HINT = { draft_email: "Abre el redactor con el borrador", create_task: "Nueva tarea", create_event: "Nuevo evento", add_fact: "Se guarda en Datos clave", set_due: "Cambia la fecha de esta tarea", set_next_step: "Cambia el próximo paso del tema" };
function assistHTML(t) {
  if (assistBusy[t.id]) return `<div class="assist"><p class="note-sim">Claude está leyendo la tarea…</p></div>`;
  const a = parseAI(t);
  if (!a) return `<div class="assist"><p class="note-sim">Escribe una descripción y pulsa «Guardar y pedir ayuda»: Claude te dirá qué hacer y podrá preparar cosas por ti (un email, recordatorios, eventos…).</p></div>`;
  return `<div class="assist">
    <div class="assist-head"><span class="spark" aria-hidden="true">✦</span><b>Claude sugiere</b><button class="link" type="button" data-ask="${t.id}">Volver a preguntar</button></div>
    ${a.summary ? `<p>${esc(a.summary)}</p>` : ""}
    ${a.steps?.length ? `<ol>${a.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}
    ${a.actions?.length ? `<div class="assist-acts">${a.actions.map((x, i) => x.done
      ? `<span class="act-done">✓ ${esc(x.label)}</span>`
      : `<button class="btn light" type="button" data-ai-act="${t.id}" data-i="${i}" title="${esc(ACTION_HINT[x.type] || "")}">${esc(x.label)}</button>`).join("")}</div>` : ""}
  </div>`;
}
/** Ficha de una tarea: editar, mover, descripción y ayuda de Claude */
function taskEditForm(t, tag = "li") {
  const topics = S.topics.filter((x) => x.slug !== "documentos");
  const who = [...S.users.map((u) => [u.email, u.name]), ["both", "Los dos"]];
  return `<${tag} class="tedit"><form class="task-edit" data-task-form="${t.id}">
    <input type="text" name="title" value="${esc(t.title)}" aria-label="Tarea">
    <select name="topic" aria-label="Tema"><option value="">Sin tema</option>${topics.map((x) => `<option value="${x.slug}" ${x.id === t.topic_id ? "selected" : ""}>${esc(x.name)}${x.private_to ? " (privado)" : ""}</option>`).join("")}</select>
    <input type="date" name="due" value="${t.due_date || ""}" aria-label="Fecha límite">
    <select name="assignee" aria-label="Para quién">${who.map(([v, l]) => `<option value="${v}" ${t.assignee === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
    <textarea name="notes" rows="3" placeholder="Descripción: qué hay que hacer, referencias, con quién hablar…" aria-label="Descripción">${esc(t.notes || "")}</textarea>
    <span class="actions"><button class="btn light" type="submit">Guardar</button><button class="btn" type="submit" data-ask-on-save>Guardar y pedir ayuda</button><button class="link" type="button" data-task-edit-cancel>Cerrar</button></span>
  </form>${commentsHTML(t)}${assistHTML(t)}</${tag}>`;
}
const commentsOf = (id) => (S.comments || []).filter((c) => c.task_id === id);
function commentsHTML(t) {
  const list = commentsOf(t.id);
  const when = (at) => { const d = new Date(at.replace(" ", "T") + "Z"); return d.toLocaleDateString("es-ES", { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }); };
  return `<div class="comments">
    <h5>Comentarios</h5>
    ${list.map((c) => `<div class="cmt ${c.author === S.me ? "mine" : ""}"><div class="cmt-meta"><b>${esc(userName(c.author))}</b> · ${esc(when(c.at))}${c.author === S.me ? `<button class="tdel" type="button" data-cmt-del="${c.id}" aria-label="Borrar comentario" title="Borrar">×</button>` : ""}</div><div class="cmt-text">${esc(c.text)}</div></div>`).join("") || `<p class="note-sim">Todavía no hay comentarios. Úsalos para organizaros: quién llama, qué falta, dudas…</p>`}
    <form class="cmt-form" data-cmt-form="${t.id}"><input type="text" name="text" placeholder="Escribe un comentario…" aria-label="Comentario" autocomplete="off"><button class="btn light" type="submit">Enviar</button></form>
  </div>`;
}
/** Marca en la lista: 💬 n, resaltado si el último comentario es del otro */
function cmtMark(t) {
  const list = commentsOf(t.id); if (!list.length) return "";
  const other = list[list.length - 1].author !== S.me;
  return `<span class="cmark ${other ? "new" : ""}" title="${other ? "Último comentario de " + esc(userName(list[list.length - 1].author)) : "Comentarios"}">💬${list.length}</span>`;
}
async function askClaude(id) {
  assistBusy[id] = true; renderAll();
  try { await post(`/api/tasks/${id}/assist`); } catch (e) { say("⚠ " + e.message, true); }
  delete assistBusy[id]; await load(); renderAll();
}
async function runAction(taskId, i) {
  const t = S.tasks.find((x) => x.id === taskId); const a = parseAI(t)?.actions?.[i]; if (!t || !a) return;
  const topic = topicById(t.topic_id); const slug = topic?.slug;
  try {
    if (a.type === "draft_email") {
      if (!slug) throw new Error("Asigna la tarea a un tema para poder redactar el email");
      await post(`/api/tasks/${taskId}/ai-done`, { index: i });
      editingTask = null; openTopic(slug, { scrollTo: "composer" });
      await compose(slug, { request: a.request || t.title, lang: a.lang });
      await load(); renderAll(); say("Borrador listo: revísalo y envíalo desde tu correo.");
      return;
    }
    if (a.type === "create_task") await post("/api/tasks", { title: a.title || a.label, topic: slug || null, due_date: a.date || null });
    else if (a.type === "create_event") {
      const s2 = slug || topicBySlug("eventos")?.slug; if (!s2) throw new Error("No hay tema para el evento");
      await post(`/api/topics/${s2}/events`, { title: a.title || a.label, date: a.date, time: a.time, place: a.place });
    } else if (a.type === "add_fact") {
      if (!slug) throw new Error("Asigna la tarea a un tema primero");
      await post(`/api/topics/${slug}/items`, { kind: "fact", label: a.key || a.label, value: a.value || "" });
    } else if (a.type === "set_due") await post(`/api/tasks/${taskId}`, { due_date: a.date }, "PATCH");
    else if (a.type === "set_next_step") {
      if (!slug) throw new Error("Asigna la tarea a un tema primero");
      await post(`/api/topics/${slug}`, { next_step: a.text || a.label }, "PATCH");
    }
    await post(`/api/tasks/${taskId}/ai-done`, { index: i });
    await load(); renderAll(); say(`Hecho: ${a.label}.`);
  } catch (e) { say("⚠ " + e.message, true); }
}

/* =========================================================
   PORTADA
   ========================================================= */
function renderMeter() {
  const d = new Date();
  $("m-date").textContent = d.toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short" });
  const c = S.credit || {};
  const b = $("m-credit");
  b.textContent = c.left == null ? "— €" : `${c.left.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  b.classList.toggle("low", c.left != null && c.left < 2);
  b.title = c.left == null ? "Pulsa para poner el saldo de la API" : `Gastado desde la última recarga: ${(c.spent || 0).toFixed(2).replace(".", ",")} €. Pulsa para actualizar el saldo.`;
}
function renderAll() {
  if (!S) return;
  renderMeter();
  const open = S.tasks.filter((t) => t.status === "open").sort(byDue);
  const done = S.tasks.filter((t) => t.status === "done").sort((a, b) => (a.completed_at < b.completed_at ? 1 : -1)).slice(0, 30);
  const row = (t) => editingTask === t.id ? taskEditForm(t) : `<li class="${t.status === "done" ? "done" : ""}">
    <input type="checkbox" id="cb-${t.id}" data-task="${t.id}" ${t.status === "done" ? "checked" : ""} aria-label="Hecha">
    <button type="button" class="tt" data-task-edit="${t.id}" title="Abrir la tarea">${esc(t.title)}${t.ai ? `<span class="tmark" title="Claude ha sugerido qué hacer">✦</span>` : t.notes ? `<span class="tmark" title="Tiene descripción">≡</span>` : ""}${cmtMark(t)}</button>
    <span class="tm">${esc(tName(t.topic_id))}</span>
    <span class="tw">${esc(userName(t.status === "done" ? t.completed_by : t.assignee))}</span>
    <span class="td">${t.status === "done" ? fmt(t.completed_at.slice(0, 10)) : dueBadge(t.due_date)}</span>
    ${pendingTaskDel === t.id ? `<button class="tdel on" type="button" data-task-del-ok="${t.id}">Borrar</button>` : `<button class="tdel" type="button" data-task-del="${t.id}" aria-label="Borrar tarea" title="Borrar tarea">×</button>`}</li>`;
  $("open-list").innerHTML = open.map(row).join("") || `<li class="empty">Nada pendiente.</li>`;
  $("done-list").innerHTML = done.map(row).join("");
  $("done-sum").textContent = `Hechas (${S.tasks.length - open.length})`;
  $("ov-count").textContent = open.length;

  $("groups").innerHTML = `<div class="cards topics-grid">${S.topics.map((t) => {
    const n = open.filter((x) => x.topic_id === t.id).length;
    const m = S.mails.filter((x) => x.topic_id === t.id && x.state === "new").length;
    const cattr = t.color ? ` data-color="${esc(t.color)}"` : "";
    if (t.slug === "documentos") {
      const nf = (S.files || []).length;
      return `<button type="button" class="card topic" data-topic="${t.slug}"${cattr}>
      <h3 style="margin:0">${esc(t.name)}</h3><div class="badges" style="justify-content:flex-start">${nf ? `<span class="badge mute">${plural(nf, "archivo", "archivos")}</span>` : ""}</div></button>`;
    }
    const badges = [
      m ? `<span class="badge info">${plural(m, "correo", "correos")}</span>` : "",
      n ? `<span class="badge warn">${plural(n, "pendiente", "pendientes")}</span>` : "",
      !m && !n && t.status_summary ? `<span class="badge">Al día</span>` : "",
    ].join("");
    return `<button type="button" class="card topic" data-topic="${t.slug}"${cattr}>
      <h3 style="margin:0">${t.private_to ? `<span class="lock" title="Solo lo ves tú">${lock}</span>` : ""}${esc(t.name)}</h3><div class="badges" style="justify-content:flex-start">${badges}</div></button>`;
  }).join("")}${creatingTopic
    ? `<form class="card topic new-topic" id="new-topic"><input type="text" id="nt-name" placeholder="Nombre del tema" aria-label="Nombre del tema" maxlength="60">
      <label class="check" for="nt-private"><input type="checkbox" id="nt-private"> Solo para mí</label><div class="actions"><button class="btn" type="submit">Crear</button><button class="link" type="button" id="nt-cancel">Cancelar</button></div></form>`
    : `<button type="button" class="card topic new-topic" id="nt-open"><h3 style="margin:0">+ Nuevo tema</h3></button>`}</div>`;
  $("nt-open")?.addEventListener("click", () => { creatingTopic = true; renderAll(); $("nt-name").focus(); });
  $("nt-cancel")?.addEventListener("click", () => { creatingTopic = false; renderAll(); });
  $("new-topic")?.addEventListener("submit", (e) => {
    e.preventDefault(); const name = $("nt-name").value.trim(); if (!name) return;
    creatingTopic = false;
    const priv = $("nt-private").checked;
    act(() => post("/api/topics", { name, private: priv }), priv ? `Tema privado «${name}» creado: solo lo ves tú.` : `Tema «${name}» creado.`).then((r) => r?.slug && openTopic(r.slug)).catch(() => {});
  });

  renderCalendar();
  renderAlerts();
  if (currentTopic) renderTopic(currentTopic);
}

/* ---------- calendario ---------- */
let calMonth = null, calDay = null;
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function renderCalendar() {
  const today = isoOf(new Date());
  calMonth ||= today.slice(0, 7); calDay ||= today;
  const [y, m] = calMonth.split("-").map(Number);
  const first = new Date(y, m - 1, 1), start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const byDay = {};
  S.events.forEach((e) => (byDay[e.date] ||= []).push(e));
  const dueByDay = {};
  S.tasks.filter((t) => t.status === "open" && t.due_date).forEach((t) => (dueByDay[t.due_date] ||= []).push(t));
  const upcoming = S.events.filter((e) => daysTo(e.date) >= 0 && daysTo(e.date) <= 30).length;
  $("cal-count").textContent = upcoming || "";
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = isoOf(d), evs = byDay[k] || [];
    if (i >= 35 && d.getMonth() !== m - 1) break;
    cells.push(`<button type="button" class="cal-cell ${d.getMonth() !== m - 1 ? "other" : ""} ${k === today ? "today" : ""} ${k === calDay ? "sel" : ""}" data-cal-day="${k}" aria-label="${d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" })}${evs.length ? `, ${plural(evs.length, "evento", "eventos")}` : ""}">
      <span class="dn">${d.getDate()}${dueByDay[k] ? `<i class="due-dot" title="Plazo de tarea"></i>` : ""}</span>
      ${evs.slice(0, 3).map((e) => `<span class="evbar p-${personOf(e) || "x"}">${esc(e.title)}</span>`).join("")}${evs.length > 3 ? `<span class="more">+${evs.length - 3}</span>` : ""}
    </button>`);
  }
  const dayEvs = (byDay[calDay] || []).sort((a, b) => ((a.time || "") < (b.time || "") ? -1 : 1));
  const dayTasks = dueByDay[calDay] || [];
  const topics = S.topics.filter((t) => t.slug !== "documentos");
  const url = S.calPath ? location.origin + S.calPath : "";
  $("cal-body").innerHTML = `<div class="cal card">
    <div class="cal-nav"><button class="icon-btn" type="button" data-cal-nav="-1" aria-label="Mes anterior">‹</button>
      <b>${cap(first.toLocaleDateString("es-ES", { month: "long" }))} ${y}</b>
      <button class="icon-btn" type="button" data-cal-nav="1" aria-label="Mes siguiente">›</button>
      <button class="link" type="button" data-cal-today>Hoy</button></div>
    <div class="cal-legend"><span><i class="pchip p-g"></i>${esc(S.users[0]?.name || "Gonzalo")}</span><span><i class="pchip p-s"></i>${esc(S.users[1]?.name || "Sabrina")}</span><span><i class="pchip p-b"></i>Los dos</span><span><i class="pchip p-x"></i>Sin decidir</span></div>
    <div class="cal-grid">${["L", "M", "X", "J", "V", "S", "D"].map((d) => `<span class="cal-wd">${d}</span>`).join("")}${cells.join("")}</div>
    <div class="cal-dayview">
      <h4>${esc(cap(D(calDay).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" })))}</h4>
      ${dayEvs.map((e) => eventCard(e, { noDate: true, showTopic: true })).join("") || `<p class="note-sim">Sin eventos este día.</p>`}
      ${dayTasks.length ? `<div class="cal-tasks">Plazos: ${dayTasks.map((t) => `<button class="link-plain" type="button" data-task-edit="${t.id}" data-open-ov>${esc(t.title)}</button>`).join(" · ")}</div>` : ""}
      <form class="ev-form" id="cal-add">
        <input type="text" id="ca-title" placeholder="Nuevo evento este día" aria-label="Nuevo evento">
        <input type="text" id="ca-time" placeholder="Hora" aria-label="Hora">
        <select id="ca-topic" aria-label="Tema">${topics.map((t) => `<option value="${t.slug}" ${t.slug === "eventos" ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select>
        <button class="btn light" type="submit">Añadir</button>
      </form>
    </div>
    ${url ? `<details class="past"><summary>Ver este calendario en el móvil (suscripción)</summary><div class="cal-sub"><span>Google Calendar → Otros calendarios → Desde URL; en iPhone: Ajustes → Calendario → Cuentas → Añadir calendario suscrito. Solo incluye los eventos marcados para el calendario compartido.</span>
      <code id="cal-url">${esc(url)}</code><div class="actions"><button class="btn light" type="button" id="cal-copy">Copiar dirección</button></div></div></details>` : ""}
  </div>`;
  $("cal-copy")?.addEventListener("click", (e) => copyText(url, e.target, "Dirección copiada"));
  $("cal-add").addEventListener("submit", (e) => {
    e.preventDefault(); const title = $("ca-title").value.trim(); if (!title) return;
    act(() => post(`/api/topics/${$("ca-topic").value}/events`, { title, date: calDay, time: $("ca-time").value }), "Evento añadido. Elige quién va o envía la invitación.");
  });
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- alertas ---------- */
function inDays(n) { return n < 0 ? `Hace ${plural(-n, "día", "días")}` : n === 0 ? "Hoy" : n === 1 ? "Mañana" : `En ${n} días`; }
function renderAlerts() {
  const items = [];
  S.tasks.filter((t) => t.status === "open" && t.due_date && daysTo(t.due_date) <= 30).forEach((t) =>
    items.push({ n: daysTo(t.due_date), id: t.topic_id, text: (daysTo(t.due_date) < 0 ? "Venció: " : "Plazo: ") + t.title }));
  S.mails.filter((m) => m.state === "new" && m.due && daysTo(m.due) <= 30).forEach((m) =>
    items.push({ n: daysTo(m.due), id: m.topic_id, text: m.todo || m.subject }));
  S.events.filter((e) => !personOf(e) && daysTo(e.date) >= 0 && daysTo(e.date) <= 30).forEach((e) =>
    items.push({ n: daysTo(e.date), id: e.topic_id, text: `${e.title}: falta decidir quién va` }));
  const fin = topicBySlug("finanzas");
  S.expenses.filter((e) => e.flag && e.next && daysTo(e.next) <= 30 && !S.mails.some((m) => m.state === "new" && m.from_name === e.name)).forEach((e) =>
    items.push({ n: daysTo(e.next) - 1, id: fin?.id, text: `Último día para cancelar ${e.name.toLowerCase()} (${eur(e.amount)})` }));
  items.sort((a, b) => a.n - b.n);
  $("alert-count").textContent = items.length;
  $("alert-list").innerHTML = items.slice(0, 7).map((a) => {
    const t = topicById(a.id);
    return `<li><button type="button" ${t ? `data-topic="${t.slug}"` : ""}>
      <span class="when ${a.n <= 2 ? "late" : a.n <= 7 ? "warn" : ""}">${inDays(a.n)}</span>
      <span class="what">${esc(a.text)}<span class="tag">${esc(t?.name || "Sin tema")}</span></span></button></li>`;
  }).join("") || `<li class="note-sim">Ningún plazo en los próximos 30 días.</li>`;
  $("alert-more").hidden = items.length <= 7;
  $("alert-more").textContent = `Y ${items.length - 7} más en los próximos 30 días`;
}

/* =========================================================
   FICHA DE TEMA
   ========================================================= */
const LANGS = { de: "Alemán", es: "Español", en: "Inglés" };
const ATTEND = { "": "Elige quién va", g: "Va Gonzalo", s: "Va Sabrina", b: "Vamos los dos", n: "No hace falta ir" };
const ATTEND_TXT = { g: "va Gonzalo", s: "va Sabrina", b: "vais los dos", n: "no va nadie" };

function renderTopic(slug) {
  if (slug === "documentos") return renderDocs();
  const v = det(slug); const t = v.t; if (!t) return;
  const newM = v.mails.filter((m) => m.state === "new").length;
  const badges = [
    newM ? `<span class="badge info">${plural(newM, "correo nuevo", "correos nuevos")}</span>` : "",
    v.open.length ? `<span class="badge warn">${plural(v.open.length, "pendiente", "pendientes")}</span>` : "",
    !newM && !v.open.length ? `<span class="badge">Al día</span>` : "",
  ].join("");
  const empty = (txt) => `<p class="note-sim">${txt}</p>`;
  const itemList = (rows) => rows.length ? `<ul class="kv-list">${rows.map((r) => editingItem === r.id
    ? `<li class="kv-edit"><form class="item-form" data-fact-form="${r.id}"><input type="text" name="label" value="${esc(r.label)}" aria-label="Dato"><input type="text" name="value" value="${esc(r.value)}" aria-label="Valor"><button class="btn light" type="submit">Guardar</button><button class="link" type="button" data-item-edit-cancel>Cancelar</button></form></li>`
    : `<li><button type="button" class="k k-btn" data-item-edit="${r.id}" title="Editar">${esc(r.label)}</button><button type="button" class="v k-btn" data-item-edit="${r.id}" title="Editar">${esc(r.value)}</button><button class="tdel" type="button" data-item-del="${r.id}" aria-label="Quitar" title="Quitar">×</button></li>`).join("")}</ul>` : "";
  const itemForm = (kind, ph1, ph2) => `<form class="item-form" data-item-form="${kind}"><input type="text" name="label" placeholder="${ph1}" aria-label="${ph1}"><input type="text" name="value" placeholder="${ph2}" aria-label="${ph2}"><button class="btn light" type="submit">Añadir</button></form>`;
  const pendingEv = v.events.filter((e) => !personOf(e) && daysTo(e.date) >= 0).length; // sin decidir quién va ni invitación

  const head = editingTopic === slug
    ? `<form class="card edit-topic" id="edit-topic">
        <label for="et-name">Nombre<input type="text" id="et-name" value="${esc(t.name)}" maxlength="60"></label>
        <label for="et-status">Estado actual<textarea id="et-status" rows="2">${esc(t.status_summary || "")}</textarea></label>
        <label for="et-next">Próximo paso<input type="text" id="et-next" value="${esc(t.next_step || "")}"></label>
        <div class="fields"><label for="et-to">Email habitual del destinatario<input type="email" id="et-to" value="${esc(t.email_to || "")}"></label>
        <label for="et-lang">Idioma de los emails<select id="et-lang">${Object.entries(LANGS).map(([k, l]) => `<option value="${k}" ${(t.email_lang || "de") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
        <div class="swatch-row"><span>Color de la tarjeta <small>(solo lo ves tú)</small></span>
          <div class="swatches">${COLORS.map((c) => `<button type="button" class="swatch ${(t.color || "") === c ? "on" : ""}" ${c ? `data-color="${c}"` : ""} data-swatch="${c}" title="${COLOR_NAMES[c]}" aria-label="${COLOR_NAMES[c]}"></button>`).join("")}</div></div>
        <div class="actions"><button class="btn" type="submit">Guardar</button><button class="link" type="button" id="et-cancel">Cancelar</button>
          <span style="margin-left:auto">${deletingTopic === slug
            ? `<span class="note-sim">Se borran sus datos, historial, correos y eventos; ${t.private_to ? "también sus tareas" : "las tareas quedan sin tema"}.</span> <button class="link danger" type="button" id="et-del-ok">Sí, borrar el tema</button> <button class="link" type="button" id="et-del-no">No</button>`
            : `<button class="link danger" type="button" id="et-del">Borrar tema</button>`}</span></div>
      </form>`
    : `    <div class="callout"><b>Estado actual:</b> ${esc(t.status_summary || "Todavía no hay nada guardado en este tema.")}${t.next_step ? `<br><b>Próximo paso:</b> ${esc(t.next_step)}` : ""}</div>`;

  const privateBar = `${t.private_to ? `<div class="private-bar"><span>${lock} Tema privado: solo lo ves tú.</span>${sharingTopic === slug
        ? `<span class="actions"><span>¿Compartirlo con ${esc(otherUser()?.name || "tu pareja")}? Verá todo: tareas, historial, correos y datos.</span><button class="btn" type="button" id="share-ok">Sí, compartir</button><button class="link" type="button" id="share-no">No</button></span>`
        : `<button class="btn light" type="button" id="share">Compartir con ${esc(otherUser()?.name || "los dos")}</button>`}</div>` : ""}`;
  $("topic-detail").innerHTML = `
    <div class="topic-head"><div><h2>${t.private_to ? `<span class="lock" title="Solo lo ves tú">${lock}</span>` : ""}${esc(t.name)}</h2></div><div class="badges">${badges}${editingTopic === slug ? "" : `<button class="link" type="button" id="et-open">Editar</button>`}</div></div>
    ${privateBar}
    ${head}
    <div class="full">
      ${fold("tasks-" + slug, foldTitle("Pendientes", v.open.length ? String(v.open.length) : ""), (v.open.length ? v.open.map((x) => editingTask === x.id ? taskEditForm(x, "div") : `<div class="mini-task">
          <input type="checkbox" id="tcb-${x.id}" data-task="${x.id}" aria-label="Hecha">
          <button type="button" class="grow tt-mini" data-task-edit="${x.id}" title="Abrir la tarea"><span>${esc(x.title)}${x.ai ? `<span class="tmark">✦</span>` : x.notes ? `<span class="tmark">≡</span>` : ""}${cmtMark(x)}</span><span class="foot">${esc(userName(x.assignee))}</span></button>${dueBadge(x.due_date)}
          ${pendingTaskDel === x.id ? `<button class="tdel on" type="button" data-task-del-ok="${x.id}">Borrar</button>` : `<button class="tdel" type="button" data-task-del="${x.id}" aria-label="Borrar tarea">×</button>`}</div>`).join("") : empty("No hay nada pendiente en este tema."))
        + `<form class="item-form" id="add-task"><input type="text" id="at-title" placeholder="Nueva tarea" aria-label="Nueva tarea"><input type="date" id="at-due" aria-label="Fecha límite"><button class="btn light" type="submit">Añadir</button></form>`, true)}
      ${mailsHTML(v.mails)}
      ${fold("events-" + slug, foldTitle("Eventos", pendingEv ? `<span style="color:var(--warn)">${plural(pendingEv, "evento", "eventos")} sin decidir quién va</span>` : v.events.length ? String(v.events.length) : ""), eventsBody(slug, v.events))}
      ${slug === "finanzas" ? dashboardHTML() : ""}
      ${slug === "viajes" ? fold("trip", foldTitle("Planear un viaje"), `<div id="trip-slot"></div>`) : ""}
      ${fold("facts-" + slug, foldTitle("Datos clave"), itemList(v.facts) + itemForm("fact", "Dato (p. ej. Nº de cliente)", "Valor"))}
      ${composerHTML(slug)}
      ${fold("hist-" + slug, foldTitle("Historial"), `<form class="note-form" id="note-form"><input type="text" id="note-text" placeholder="Añadir una nota (pasa a ser el estado actual)" aria-label="Nota"><button class="btn" type="submit">Guardar</button></form>
          ${v.history.length ? `<ul class="timeline">${v.history.slice(0, 30).map((h) => `<li><time>${esc(fmt(h.at))}</time><div>${esc(h.text)}<div class="src">vía ${esc(h.source)}</div></div></li>`).join("")}</ul>` : empty("Todavía no hay historial.")}`)}
      ${fold("contacts-" + slug, foldTitle("Contactos"), contactsBody(slug, v.contacts), slug === "colegio")}
      ${(S.panels || []).filter((cp) => cp.topic_id === t.id).map((cp) => `<details class="fold" data-fold="cp${cp.id}" ${uiOpen["cp" + cp.id] ? "open" : ""}>
        <summary>${foldTitle(esc(cp.title), cp.body ? "" : "vacío")}${delPanel === cp.id
          ? `<button type="button" class="fold-x on" data-del-panel-ok="${cp.id}">Borrar</button>`
          : `<button type="button" class="fold-x" data-del-panel="${cp.id}" aria-label="Borrar panel" title="Borrar este panel">×</button>`}<span class="chev" aria-hidden="true">▾</span></summary>
        <div class="fold-body"><textarea class="panel-body" data-panel-body="${cp.id}" rows="5" placeholder="Escribe aquí lo que quieras: se guarda solo.">${esc(cp.body || "")}</textarea></div></details>`).join("")}
    </div>
    ${addPanelHTML(slug, t)}`;

  const hidden = hiddenOf(t);
  $("topic-detail").querySelectorAll("details.fold[data-panel]").forEach((d) => { if (hidden.includes(d.dataset.panel)) d.remove(); });
  if (slug === "viajes") $("trip-slot")?.appendChild(tripPanel);
  wireTopic(slug, v);
}

/* ---------- contactos por apartados (en Colegios: General y cada hijo) ---------- */
const KIDS = ["Valentina", "Paul", "Santiago"];
const presetTo = {}; // email elegido desde Contactos para el próximo borrador
let addingContact = null; // apartado en el que se está añadiendo un contacto
let editingItem = null;   // contacto o dato clave que se está editando
const cExtra = (c) => { try { return c.extra ? JSON.parse(c.extra) : {}; } catch { return {}; } };
const isEmail = (x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x || "");
function contactsBody(slug, contacts) {
  const used = contacts.map((c) => cExtra(c).g || "General");
  const groups = [...new Set([...(slug === "colegio" ? ["General", ...KIDS] : ["General"]), ...used])];
  const one = (c) => {
    const x = cExtra(c), v = (c.value || "").trim();
    const mail = isEmail(v) ? v : "";
    const looksTel = /^[+\d][\d\s/().-]{4,}$/.test(v);
    const tel = x.tel || (!mail && looksTel ? v : "");
    const note = !mail && v && v !== tel ? v : ""; // texto libre en lugar de email
    if (editingItem === c.id) return `<form class="ci-edit" data-contact-form="${c.id}">
      <input type="text" name="label" value="${esc(c.label)}" placeholder="Quién" aria-label="Quién">
      <input type="text" name="value" value="${esc(mail || note)}" placeholder="Email o una nota corta" aria-label="Email o nota" autocapitalize="off">
      <input type="tel" name="tel" value="${esc(tel)}" placeholder="Teléfono" aria-label="Teléfono">
      <select name="g" aria-label="Apartado">${groups.map((g) => `<option ${g === (x.g || "General") ? "selected" : ""}>${esc(g)}</option>`).join("")}</select>
      <span class="actions"><button class="btn light" type="submit">Guardar</button><button class="link" type="button" data-item-edit-cancel>Cancelar</button></span>
    </form>`;
    return `<div class="ci"><div class="ci-top"><button type="button" class="ci-name" data-item-edit="${c.id}" title="Editar contacto">${esc(c.label)}</button><button class="tdel" type="button" data-item-del="${c.id}" aria-label="Quitar contacto" title="Quitar">×</button></div>
      ${mail ? `<button type="button" class="ci-mail" data-mail-to="${esc(mail)}" title="Escribir un email a ${esc(mail)}">✉ ${esc(mail)}</button>` : ""}
      ${note ? `<span class="ci-note">${esc(note)}</span>` : ""}
      ${tel ? `<a class="ci-tel" href="tel:${esc(tel.replace(/[^\d+]/g, ""))}">☎ ${esc(tel)}</a>` : ""}</div>`;
  };
  return `<div class="cgrid">${groups.map((g) => {
      const list = contacts.filter((c) => (cExtra(c).g || "General") === g);
      return `<div class="cgroup"><h5>${esc(g)}<button type="button" class="c-add" data-add-contact="${esc(g)}" aria-label="Añadir contacto en ${esc(g)}" title="Añadir contacto">+</button></h5>${list.map(one).join("") || `<span class="ci-empty">—</span>`}</div>`;
    }).join("")}</div>
    ${addingContact == null ? "" : `<form class="contact-form" id="contact-form">
      <select id="cf-g" aria-label="Apartado">${groups.map((g) => `<option ${g === addingContact ? "selected" : ""}>${esc(g)}</option>`).join("")}</select>
      <input type="text" id="cf-name" placeholder="Quién (p. ej. Tutora)" aria-label="Quién">
      <input type="text" id="cf-mail" placeholder="Email o una nota corta" aria-label="Email o nota" autocomplete="off" autocapitalize="off">
      <input type="tel" id="cf-tel" placeholder="Teléfono" aria-label="Teléfono">
      <span class="actions"><button class="btn light" type="submit">Añadir</button><button class="link" type="button" id="cf-cancel">Cancelar</button></span>
    </form>`}`;
}

/* ---------- añadir / quitar paneles ---------- */
function addPanelHTML(slug, t) {
  const avail = Object.keys(PANELS).filter((k) => (k !== "gastos" && k !== "subs" || slug === "finanzas") && (k !== "trip" || slug === "viajes"));
  const hidden = hiddenOf(t).filter((k) => avail.includes(k));
  if (!addingPanel) return `<div class="add-panel"><button class="link" type="button" id="ap-open">+ Añadir panel</button>${hidden.length ? `<span class="note-sim">${plural(hidden.length, "panel oculto", "paneles ocultos")}</span>` : ""}</div>`;
  return `<div class="add-panel open">
    ${hidden.length ? `<div class="ap-row"><span class="note-sim">Volver a mostrar:</span>${hidden.map((k) => `<button class="btn light" type="button" data-show-panel="${k}">${PANELS[k]}</button>`).join("")}</div>` : ""}
    <form class="item-form" id="ap-form"><input type="text" id="ap-title" placeholder="Panel de texto nuevo (p. ej. Contraseñas wifi, Notas)" aria-label="Nombre del panel" maxlength="60"><button class="btn light" type="submit">Crear</button><button class="link" type="button" id="ap-close">Cerrar</button></form>
  </div>`;
}
function setHidden(slug, list) {
  const t = topicBySlug(slug); t.hidden = JSON.stringify(list); renderTopic(slug);
  post(`/api/topics/${slug}/hidden`, { hidden: list }, "PUT").catch((e) => say("⚠ " + e.message, true));
}

/* ---------- documentos compartidos ---------- */
const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const extOf = (f) => (f.name.split(".").pop() || "").slice(0, 4).toUpperCase() || "DOC";
let pendingDelete = null;
function renderDocs() {
  const files = S.files || [];
  $("topic-detail").innerHTML = `
    <div class="topic-head"><div><h2>Documentos compartidos</h2></div><div class="badges"><span class="badge mute">${plural(files.length, "archivo", "archivos")}</span></div></div>
    <div class="full">
      <div class="card drop" id="drop">
        <h4>Subir archivos</h4>
        <p>Fotos, PDFs o cualquier archivo pequeño (hasta 10 MB cada uno). Desde el móvil puedes elegir de la fototeca o hacer una foto.</p>
        <div class="actions"><label class="btn" for="file-input" style="color:var(--ink-fg);cursor:pointer">Elegir archivos</label><span class="note-sim" id="up-msg"></span></div>
        <input type="file" id="file-input" multiple hidden>
      </div>
      <div class="card">
        <h4>Archivos</h4>
        ${files.length ? `<ul class="files doc-list">${files.map((f) => `<li>
          <span class="ext">${esc(extOf(f))}</span>
          <a class="doc-name" href="/api/files/${f.id}" target="_blank" rel="noopener">${esc(f.name)}</a>
          <span class="when">${kb(f.size)} · ${esc(userName(f.uploaded_by))} · ${esc(fmt(f.created_at.slice(0, 10)))}</span>
          ${pendingDelete === f.id
            ? `<span class="doc-act"><button class="link danger" type="button" data-del-ok="${f.id}">Borrar</button><button class="link" type="button" data-del-no>Cancelar</button></span>`
            : `<span class="doc-act"><button class="link danger" type="button" data-del="${f.id}" aria-label="Borrar ${esc(f.name)}">Quitar</button></span>`}
        </li>`).join("")}</ul>` : `<p class="note-sim">Todavía no hay archivos.</p>`}
      </div>
    </div>`;
  $("file-input").addEventListener("change", (e) => uploadFiles([...e.target.files]));
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => uploadFiles([...(e.dataTransfer?.files || [])]));
  $("topic-detail").querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => { pendingDelete = +b.dataset.del; renderDocs(); }));
  $("topic-detail").querySelector("[data-del-no]")?.addEventListener("click", () => { pendingDelete = null; renderDocs(); });
  $("topic-detail").querySelector("[data-del-ok]")?.addEventListener("click", (e) => {
    const id = +e.target.dataset.delOk; pendingDelete = null;
    act(() => post(`/api/files/${id}`, {}, "DELETE"), "Archivo borrado.");
  });
}
async function uploadFiles(list) {
  if (!list.length) return;
  const msg = $("up-msg"); let ok = 0;
  for (const [i, f] of list.entries()) {
    if (f.size > 10 * 1048576) { say(`«${f.name}» pesa ${kb(f.size)}; el máximo es 10 MB.`, true); continue; }
    if (msg) msg.textContent = `Subiendo ${i + 1} de ${list.length}: ${f.name}…`;
    try {
      const res = await fetch(`/api/files?name=${encodeURIComponent(f.name)}`, { method: "POST", headers: { "content-type": f.type || "application/octet-stream" }, body: f });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      ok++;
    } catch (e) { say(`⚠ No se pudo subir «${f.name}»: ${e.message}`, true); }
  }
  await load(); renderAll();
  if (ok) say(`${plural(ok, "archivo subido", "archivos subidos")}.`);
}

/* ---------- correos recibidos ---------- */
function mailsHTML(mails) {
  if (!mails.length) return "";
  const nNew = mails.filter((m) => m.state === "new").length;
  const STATE = { new: `<span class="badge info">Nuevo</span>`, task: `<span class="badge">Tarea creada</span>`, replying: `<span class="badge warn">Respondiendo</span>`, done: `<span class="badge">Respondido</span>` };
  return fold("mails-" + currentTopic, `<span class="fold-title">Correos recibidos</span>${nNew ? `<span class="fold-meta" style="color:var(--info)">${plural(nNew, "nuevo", "nuevos")}</span>` : ""}`,
    mails.map((m) => `<div class="mail ${m.state === "new" ? "new" : ""}">
      <div class="mail-top"><span><b style="color:var(--fg)">${esc(m.from_name)}</b> · ${esc(fmt(m.received_at))}${m.lang ? ` · en ${esc(m.lang.toLowerCase())}` : ""}</span>${STATE[m.state] || ""}</div>
      <div class="mail-subj">${esc(m.subject)}</div>
      <dl class="intent"><dt>Qué quieren</dt><dd>${esc(m.intent)}</dd><dt>Qué hacer</dt><dd><b>${esc(m.todo)}</b></dd>${m.due ? `<dt>Plazo</dt><dd>${dueBadge(m.due)} ${esc(fmt(m.due))}</dd>` : ""}</dl>
      <div class="actions">
        ${m.state === "new" ? `<button class="btn" type="button" data-mail="task" data-m="${m.id}">Crear tarea</button>` : ""}
        ${m.state !== "done" ? `<button class="btn light" type="button" data-mail="reply" data-m="${m.id}">Responder</button>` : ""}
        <button class="link" type="button" data-mail="archive" data-m="${m.id}">Archivar</button>
      </div></div>`).join(""));
}

/* ---------- eventos ---------- */
let invitingEv = null, editingEv = null, delEv = null;
const parseJ = (x, d) => { try { return x ? JSON.parse(x) : d; } catch { return d; } };
/** Quién va: "g", "s", "b" o "" (sin decidir), según «¿Quién va?» o, si no, a quién se invitó */
function personOf(ev) {
  if (["g", "s", "b"].includes(ev.attendee)) return ev.attendee;
  const inv = parseJ(ev.invited, []);
  if (inv.length >= 2) return "b";
  if (inv.length === 1) return (S.users.find((u) => u.email === inv[0])?.name || "x")[0].toLowerCase();
  return "";
}
const RSVP = { ACCEPTED: "aceptó", DECLINED: "no va", TENTATIVE: "quizás" };
const TZ_CITY = { "Asia/Shanghai": "Pekín", "Europe/Berlin": "Berlín", "Europe/Madrid": "Madrid", "Europe/London": "Londres", "America/New_York": "Nueva York" };
const DEFAULT_TZ = "Asia/Shanghai";
/** Hora con la ciudad de su zona horaria: «13:45 (Pekín)» */
const evTime = (ev) => ev.time ? `${ev.time} (${TZ_CITY[ev.tz] || TZ_CITY[DEFAULT_TZ]})` : "";
const openEv = new Set(); // eventos ya invitados que se han desplegado a mano
function eventCard(ev, opts = {}) {
  const p = personOf(ev), inv = parseJ(ev.invited, []), rsvp = parseJ(ev.rsvp, {});
  const topic = topicById(ev.topic_id);
  // Con la invitación enviada, el evento queda plegado en una línea (el color ya dice para quién es)
  if (inv.length && !openEv.has(ev.id) && invitingEv !== ev.id && editingEv !== ev.id && delEv !== ev.id) {
    const answers = inv.map((e) => rsvp[e]).filter(Boolean);
    return `<button type="button" class="ev-mini p-${p || "x"}" data-ev-expand="${ev.id}" title="Mostrar detalles">
      <span class="pchip p-${p || "x"}" aria-hidden="true"></span><b>${esc(ev.title)}</b>
      <span class="ev-mini-when">${opts.noDate ? "" : esc(fmt(ev.date)) + (ev.time ? " · " : "")}${esc(evTime(ev))}</span>
      <span class="ev-mini-st">✉${answers.includes("ACCEPTED") ? " ✓" : answers.includes("DECLINED") ? " ✗" : ""}</span><span class="chev" aria-hidden="true">▾</span></button>`;
  }
  const invLine = inv.length ? `<div class="ev-inv">✉ Invitación enviada a ${inv.map((e) => `${esc(userName(e))}${rsvp[e] ? ` (${RSVP[rsvp[e]] || rsvp[e].toLowerCase()})` : ""}`).join(" · ")}</div>` : "";
  if (editingEv === ev.id) return `<div class="ev-card p-${p || "x"}"><form class="ev-edit" data-ev-form="${ev.id}">
      <input type="text" name="title" value="${esc(ev.title)}" aria-label="Evento">
      <input type="date" name="date" value="${ev.date}" aria-label="Fecha">
      <input type="text" name="time" value="${esc(ev.time || "")}" placeholder="Hora (19:00 o 19:00–20:30)" aria-label="Hora">
      <input type="text" name="place" value="${esc(ev.place || "")}" placeholder="Lugar" aria-label="Lugar">
      <select name="tz" aria-label="Zona horaria del lugar">${Object.entries(TZ_CITY).map(([k, c]) => `<option value="${k}" ${(ev.tz || DEFAULT_TZ) === k ? "selected" : ""}>Hora de ${c}</option>`).join("")}</select>
      <span class="actions"><button class="btn" type="submit">Guardar${inv.length ? " y avisar" : ""}</button><button class="link" type="button" data-ev-edit-cancel>Cancelar</button></span>
    </form></div>`;
  const def = ["g", "s", "b"].includes(ev.attendee) ? ev.attendee : "b";
  return `<div class="ev-card p-${p || "x"}">
    <div class="ev-head"><span class="pchip p-${p || "x"}" aria-hidden="true"></span><b>${esc(ev.title)}</b>${inv.length ? `<button type="button" class="ev-fold" data-ev-collapse="${ev.id}" aria-label="Plegar" title="Plegar">▴</button>` : ""}</div>
    <div class="ev-sub">${opts.noDate ? "" : esc(fmtLong(ev.date)) + (ev.time ? " · " : "")}${esc(evTime(ev))}${ev.place ? ` · ${esc(ev.place)}` : ""}${ev.who ? ` · ${esc(ev.who)}` : ""}${opts.showTopic && topic ? ` · <button class="link-plain" type="button" data-topic-open="${topic.slug}">${esc(topic.name)}</button>` : ""}</div>
    ${ev.note ? `<div class="ev-note">${esc(ev.note)}</div>` : ""}
    ${invLine}
    ${invitingEv === ev.id
      ? `<div class="ev-row"><span class="note-sim">Enviar invitación a:</span>${["g", "s", "b"].map((k) => `<button class="btn ${k === def ? "" : "light"}" type="button" data-ev-invite-to="${ev.id}" data-who="${k}">${{ g: S.users[0]?.name || "Gonzalo", s: S.users[1]?.name || "Sabrina", b: "Los dos" }[k]}</button>`).join("")}<button class="link" type="button" data-ev-invite-cancel>Cancelar</button></div>`
      : `<div class="ev-row">
          <select data-ev-att="${ev.id}" aria-label="¿Quién va?">${Object.entries(ATTEND).map(([k, l]) => `<option value="${k}" ${(ev.attendee || "") === k ? "selected" : ""}>${l}</option>`).join("")}</select>
          <button class="btn light" type="button" data-ev-invite="${ev.id}">✉ Invitar</button>
          <button class="link" type="button" data-ev-edit="${ev.id}">Editar</button>
          ${delEv === ev.id ? `<button class="link danger" type="button" data-ev-del-ok="${ev.id}">${inv.length ? "Borrar y cancelar invitación" : "Sí, borrar"}</button>` : `<button class="link danger" type="button" data-ev-del="${ev.id}">Borrar</button>`}
        </div>`}
  </div>`;
}
function eventsBody(slug, events) {
  const evs = [...events].sort((a, b) => (a.date < b.date ? -1 : 1));
  const past = evs.filter((e) => daysTo(e.date) < 0), next = evs.filter((e) => daysTo(e.date) >= 0);
  return `<div style="display:grid;gap:8px">${next.map((e) => eventCard(e)).join("") || `<p class="note-sim">Sin eventos próximos. Llegan solos de los correos reenviados a inbox@, o añádelos aquí.</p>`}
    ${past.length ? `<details class="past"><summary>${plural(past.length, "evento pasado", "eventos pasados")}</summary>${past.reverse().map((e) => eventCard(e)).join("")}</details>` : ""}
    <form class="ev-form" id="add-event">
      <input type="text" id="ae-title" placeholder="Evento (p. ej. Cumpleaños de la abuela)" aria-label="Evento">
      <input type="date" id="ae-date" aria-label="Fecha">
      <input type="text" id="ae-time" placeholder="Hora" aria-label="Hora">
      <input type="text" id="ae-place" placeholder="Lugar" aria-label="Lugar">
      <button class="btn light" type="submit">Añadir</button>
    </form></div>`;
}

/* ---------- gastos y suscripciones (Finanzas) ---------- */
const perMonth = (e) => (e.cycle === "mes" ? e.amount : e.cycle === "año" ? e.amount / 12 : e.amount / 3);
function dashboardHTML() {
  const E = S.expenses;
  if (!E.length) return fold("gastos", foldTitle("Gastos fijos y suscripciones", "vacío"), `<p class="note-sim">Añade alquiler, seguros, suscripciones… y aquí verás cuánto gastáis al mes y al año.</p>${expenseForm()}`);
  const fixedM = E.filter((e) => !e.sub).reduce((s, e) => s + perMonth(e), 0);
  const subs = E.filter((e) => e.sub);
  const subsM = subs.reduce((s, e) => s + perMonth(e), 0);
  const cats = {}; E.forEach((e) => (cats[e.cat] = (cats[e.cat] || 0) + perMonth(e)));
  const max = Math.max(...Object.values(cats));
  const upcoming = E.filter((e) => e.next && daysTo(e.next) >= 0 && daysTo(e.next) <= 14).length;
  const rows = [...E].sort((a, b) => perMonth(b) - perMonth(a));
  const flagged = subs.filter((e) => e.flag).length;
  return fold("gastos", `<span class="fold-title">Vista general de gastos</span><span class="fold-meta">${eur(fixedM + subsM)} al mes</span>`,
    `<div class="kpis">
      <div class="kpi"><div class="lbl">Gastos fijos al mes</div><div class="stat">${eur(fixedM)}</div><div class="foot">Anuales y trimestrales prorrateados</div></div>
      <div class="kpi"><div class="lbl">Suscripciones al mes</div><div class="stat">${eur(subsM)}</div><div class="foot">${plural(subs.length, "activa", "activas")}</div></div>
      <div class="kpi"><div class="lbl">Total al año</div><div class="stat">${eur((fixedM + subsM) * 12)}</div><div class="foot">${plural(upcoming, "cargo", "cargos")} en los próximos 14 días</div></div>
    </div>
    <h4>Por categoría, al mes</h4>
    <div class="bars">${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, v]) => `
      <div class="bar-row"><span>${esc(c)}</span><div class="bar-track"><div class="bar-fill" style="width:${((v / max) * 100).toFixed(1)}%"></div></div><span class="amt">${eur(v)}</span></div>`).join("")}</div>
    <h4>Todos los cargos</h4>
    <div class="table-wrap"><table class="subs"><thead><tr><th>Concepto</th><th class="num">Importe</th><th class="num">Al mes</th><th>Próximo cargo</th><th>Cancelación</th><th></th></tr></thead><tbody>
      ${rows.map((e) => `<tr><td>${esc(e.name)}<div class="sub">${esc(e.cat)}${e.sub ? " · suscripción" : ""}</div></td>
        <td class="num">${eur(e.amount)}<div class="sub">/${e.cycle}</div></td><td class="num">${eur(perMonth(e))}</td>
        <td>${e.next ? fmt(e.next) : "—"}</td><td>${esc(e.notice || "")}</td><td><button class="tdel" type="button" data-sub-del="${e.id}" aria-label="Quitar ${esc(e.name)}" title="Quitar">×</button></td></tr>`).join("")}
    </tbody></table></div>${expenseForm()}`)
  + fold("subs", `<span class="fold-title">Suscripciones</span><span class="fold-meta">${subs.length} · ${eur(subsM)} al mes${flagged ? ` · <span style="color:var(--warn)">${flagged} por revisar</span>` : ""}</span>`, subsBody(subs));
}
function subsBody(subs) {
  return `<ul class="sub-list">${[...subs].sort((a, b) => ((a.next || "9") < (b.next || "9") ? -1 : 1)).map((e) => `<li class="${e.flag ? "flag" : ""}">
      <div class="sl-main"><b>${esc(e.name)}</b><span>${eur(e.amount)} /${e.cycle}${e.next ? ` · próximo cargo ${fmt(e.next)}` : ""} · cancelación: ${esc((e.notice || "").toLowerCase())}</span>
        ${e.flag ? `<span class="sl-flag">${esc(e.flag)}</span>` : ""}</div>
      <div class="sl-act"><button class="link" type="button" data-cancel="${esc(e.name)}">Email de baja</button><button class="link danger" type="button" data-sub-del="${e.id}">Quitar</button></div>
    </li>`).join("") || `<li><span class="note-sim">No hay suscripciones.</span></li>`}</ul>
`;
}
function expenseForm() {
  return `<form class="sub-form" id="sub-form">
      <h4>Añadir gasto o suscripción</h4>
      <div class="fields">
        <label for="sf-kind">Tipo<select id="sf-kind"><option value="sub">Suscripción</option><option value="fijo">Gasto fijo</option></select></label>
        <label for="sf-name">Nombre<input type="text" id="sf-name" placeholder="p. ej. Seguro de hogar" required></label>
        <label for="sf-amount">Importe (€)<input type="text" id="sf-amount" inputmode="decimal" placeholder="9,99" required></label>
        <label for="sf-cycle">Se cobra<select id="sf-cycle"><option value="mes">Cada mes</option><option value="trimestre">Cada trimestre</option><option value="año">Cada año</option></select></label>
        <label for="sf-cat">Categoría (gasto fijo)<select id="sf-cat">${["Vivienda", "Seguros", "Transporte", "Comunicaciones", "Niños", "Otros"].map((c) => `<option>${c}</option>`).join("")}</select></label>
        <label for="sf-next">Próximo cargo<input type="date" id="sf-next" value="${addDays(30)}"></label>
        <label for="sf-notice">Plazo de cancelación<input type="text" id="sf-notice" placeholder="p. ej. 1 mes"></label>
      </div>
      <div class="actions"><button class="btn" type="submit">Añadir</button></div>
    </form>`;
}

/* ---------- redactor de emails ---------- */
function composerHTML(slug) {
  const t = topicBySlug(slug), dr = drafts[slug];
  const langOpts = (l) => Object.entries(LANGS).map(([k, v]) => `<option value="${k}" ${k === l ? "selected" : ""}>${v}</option>`).join("");
  let out = "";
  if (dr?.stage === "loading") {
    out = `<div class="composer-out"><span class="note-sim">Claude está escribiendo el borrador…</span></div>`;
  } else if (dr?.stage === "sent") {
    out = `<div class="composer-out"><span class="note-ok">✓ Anotado como enviado. Hay una tarea para revisar la respuesta en 2 semanas.</span>
      <div class="actions"><button class="link" type="button" data-act="new">Escribir otro email</button></div></div>`;
  } else if (dr) {
    const mailto = `mailto:${encodeURIComponent(dr.to || "")}?subject=${encodeURIComponent(dr.subject)}&body=${encodeURIComponent(dr.body)}`;
    out = `<div class="composer-out ${dr.working ? "busy" : ""}">
      ${dr.mailId ? `<span class="badge info" style="justify-self:start">Respuesta a un correo recibido</span>` : ""}
      <label for="c-to">Para<input type="email" id="c-to" value="${esc(dr.to)}" placeholder="dirección del destinatario"></label>
      <label for="c-subj">Asunto<input type="text" id="c-subj" value="${esc(dr.subject)}"></label>
      <label for="c-body">Texto (puedes corregirlo directamente)<textarea id="c-body" rows="12">${esc(dr.body)}</textarea></label>
      <form class="revise" id="c-revise"><input type="text" id="c-instr" placeholder="Pide cambios: «pásalo a inglés», «más corto»…" aria-label="Pedir cambios"><button class="btn light" type="submit">Aplicar</button></form>
      ${dr.msg ? `<span class="note-sim">${esc(dr.msg)}</span>` : ""}
      ${dr.stage === "confirm"
        ? `<div class="confirm"><span>¿Ya lo has enviado? Se guardará en el historial y se creará un recordatorio para revisar la respuesta.</span>
            <div class="actions"><button class="btn" type="button" data-act="sent-ok">Sí, enviado</button><button class="link" type="button" data-act="sent-no">Todavía no</button></div></div>`
        : `<div class="actions"><a class="btn" id="c-mailto" href="${mailto}">Abrir en el correo</a><button class="btn light" type="button" data-act="copy">Copiar</button><button class="btn light" type="button" data-act="mark">Marcar como enviado</button><button class="link danger" type="button" data-act="discard">Descartar</button></div>`}
    </div>`;
  }
  return fold("mail-" + slug, foldTitle("Escribir un email", dr?.stage === "draft" || dr?.stage === "confirm" ? "borrador abierto" : ""), `
    <p class="note-sim">Para resolver este tema, en el idioma que quieras. Déjalo en blanco y Claude propone uno a partir del próximo paso.</p>
    <form id="c-form" style="display:grid;gap:10px">
      <textarea id="c-req" rows="2" placeholder="¿Qué quieres conseguir?" aria-label="Qué quieres conseguir">${esc(dr && !dr.mailId ? dr.request || "" : "")}</textarea>
      <div class="actions"><select id="c-lang" aria-label="Idioma" style="width:auto">${langOpts(dr?.lang || t.email_lang || "de")}</select><button class="btn" type="submit">Redactar</button></div>
    </form>${out}`, false, "composer");
}
async function compose(slug, { request = "", lang, mailId } = {}) {
  drafts[slug] = { stage: "loading", request, lang, mailId };
  uiOpen["mail-" + slug] = true;
  if (currentTopic === slug) renderTopic(slug);
  try {
    const d = await post("/api/draft", { topic: slug, request, lang, mailId });
    const to = !mailId && presetTo[slug] ? presetTo[slug] : d.to;
    delete presetTo[slug];
    drafts[slug] = { stage: "draft", request, lang: d.lang, mailId, to, subject: d.subject, body: d.body, msg: "" };
  } catch (e) {
    delete drafts[slug]; say("⚠ " + e.message, true);
  }
  if (currentTopic === slug) renderTopic(slug);
}
function copyText(text, btn, okLabel = "Copiado") {
  const done = () => { if (btn) btn.textContent = okLabel; };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(() => say("No se pudo copiar automáticamente: selecciónalo y cópialo.", true));
  else say("No se pudo copiar automáticamente: selecciónalo y cópialo.", true);
}

/* ---------- eventos de la ficha ---------- */
function wireTopic(slug, v) {
  const box = $("topic-detail");
  box.querySelectorAll("[data-fold]").forEach((f) => f.addEventListener("toggle", () => (uiOpen[f.dataset.fold] = f.open)));

  $("note-form")?.addEventListener("submit", (e) => {
    e.preventDefault(); const text = $("note-text").value.trim(); if (!text) return;
    act(() => post(`/api/topics/${slug}/note`, { text }), "Nota guardada.");
  });

  // editar / borrar el tema
  $("et-open")?.addEventListener("click", () => { editingTopic = slug; deletingTopic = null; renderTopic(slug); });
  $("et-cancel")?.addEventListener("click", () => { editingTopic = null; deletingTopic = null; renderTopic(slug); });
  $("et-del")?.addEventListener("click", () => { deletingTopic = slug; renderTopic(slug); });
  $("et-del-no")?.addEventListener("click", () => { deletingTopic = null; renderTopic(slug); });
  $("et-del-ok")?.addEventListener("click", async () => {
    const name = v.t.name; editingTopic = deletingTopic = null;
    try { await post(`/api/topics/${slug}`, {}, "DELETE"); } catch (e) { return say("⚠ " + e.message, true); }
    showTab("temas"); await load(); renderAll(); say(`Tema «${name}» borrado.`); window.scrollTo({ top: 0 });
  });
  $("edit-topic")?.addEventListener("submit", (e) => {
    e.preventDefault(); editingTopic = null;
    act(() => post(`/api/topics/${slug}`, { name: $("et-name").value, status_summary: $("et-status").value, next_step: $("et-next").value, email_to: $("et-to").value, email_lang: $("et-lang").value }, "PATCH"), "Tema guardado.");
  });

  // paneles: quitar, mostrar, crear y editar paneles de texto
  box.querySelectorAll("[data-hide-panel]").forEach((b) => b.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const k = b.dataset.hidePanel; setHidden(slug, [...new Set([...hiddenOf(v.t), k])]);
    say(`Panel «${PANELS[k]}» quitado. Puedes volver a mostrarlo con «+ Añadir panel».`);
  }));
  box.querySelectorAll("[data-show-panel]").forEach((b) => b.addEventListener("click", () => setHidden(slug, hiddenOf(v.t).filter((k) => k !== b.dataset.showPanel))));
  $("ap-open")?.addEventListener("click", () => { addingPanel = true; renderTopic(slug); $("ap-title")?.focus(); });
  $("ap-close")?.addEventListener("click", () => { addingPanel = false; renderTopic(slug); });
  $("ap-form")?.addEventListener("submit", (e) => {
    e.preventDefault(); const title = $("ap-title").value.trim(); if (!title) return;
    addingPanel = false;
    act(() => post(`/api/topics/${slug}/panels`, { title }), `Panel «${title}» creado.`).then((r) => { if (r?.id) { uiOpen["cp" + r.id] = true; renderTopic(slug); } }).catch(() => {});
  });
  box.querySelectorAll("[data-del-panel]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); delPanel = +b.dataset.delPanel; renderTopic(slug); }));
  box.querySelectorAll("[data-del-panel-ok]").forEach((b) => b.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation(); delPanel = null; act(() => post(`/api/panels/${b.dataset.delPanelOk}`, {}, "DELETE"), "Panel borrado.");
  }));
  box.querySelectorAll("[data-panel-body]").forEach((ta) => {
    let timer;
    const save = () => { clearTimeout(timer); const cp = S.panels.find((x) => x.id === +ta.dataset.panelBody); if (!cp || cp.body === ta.value) return;
      cp.body = ta.value; post(`/api/panels/${cp.id}`, { body: ta.value }, "PATCH").then(() => say("Guardado.")).catch((e) => say("⚠ " + e.message, true)); };
    ta.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(save, 1200); });
    ta.addEventListener("blur", save);
  });

  // color y compartir
  box.querySelectorAll("[data-swatch]").forEach((b) => b.addEventListener("click", () =>
    act(() => post(`/api/topics/${slug}/color`, { color: b.dataset.swatch }, "PUT"), `Color: ${COLOR_NAMES[b.dataset.swatch]}.`)));
  $("share")?.addEventListener("click", () => { sharingTopic = slug; renderTopic(slug); });
  $("share-no")?.addEventListener("click", () => { sharingTopic = null; renderTopic(slug); });
  $("share-ok")?.addEventListener("click", () => { sharingTopic = null; act(() => post(`/api/topics/${slug}/share`), `«${v.t.name}» ahora lo veis los dos.`); });

  // contactos: añadir y escribir un email desde ellos
  $("contact-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const label = $("cf-name").value.trim(), mail = $("cf-mail").value.trim(), tel = $("cf-tel").value.trim();
    if (!label) { say("Escribe quién es el contacto.", true); return; }
    uiOpen["contacts-" + slug] = true; addingContact = null;
    act(() => post(`/api/topics/${slug}/items`, { kind: "contact", label, value: mail || tel, extra: JSON.stringify({ g: $("cf-g").value, tel }) }), "Contacto guardado.");
  });
  box.querySelectorAll("[data-add-contact]").forEach((b) => b.addEventListener("click", () => {
    addingContact = b.dataset.addContact; uiOpen["contacts-" + slug] = true; renderTopic(slug); $("cf-name")?.focus();
  }));
  $("cf-cancel")?.addEventListener("click", () => { addingContact = null; renderTopic(slug); });
  // editar contactos y datos clave
  box.querySelectorAll("[data-item-edit]").forEach((b) => b.addEventListener("click", () => { editingItem = +b.dataset.itemEdit; addingContact = null; renderTopic(slug); box.querySelector("[data-contact-form] input, [data-fact-form] input")?.focus(); }));
  box.querySelectorAll("[data-item-edit-cancel]").forEach((b) => b.addEventListener("click", () => { editingItem = null; renderTopic(slug); }));
  box.querySelectorAll("[data-contact-form]").forEach((f) => f.addEventListener("submit", (e) => {
    e.preventDefault();
    const label = f.elements.label.value.trim(), val = f.elements.value.value.trim(), tel = f.elements.tel.value.trim();
    if (!label) { say("Escribe quién es el contacto.", true); return; }
    editingItem = null;
    act(() => post(`/api/items/${f.dataset.contactForm}`, { label, value: val || tel, extra: JSON.stringify({ g: f.elements.g.value, tel }) }, "PATCH"), "Contacto actualizado.");
  }));
  box.querySelectorAll("[data-fact-form]").forEach((f) => f.addEventListener("submit", (e) => {
    e.preventDefault();
    const label = f.elements.label.value.trim(); if (!label) { say("Escribe el nombre del dato.", true); return; }
    editingItem = null;
    act(() => post(`/api/items/${f.dataset.factForm}`, { label, value: f.elements.value.value }, "PATCH"), "Dato actualizado.");
  }));
  box.querySelectorAll("[data-mail-to]").forEach((b) => b.addEventListener("click", () => {
    presetTo[slug] = b.dataset.mailTo; uiOpen["mail-" + slug] = true; renderTopic(slug);
    $("composer")?.scrollIntoView({ block: "start", behavior: "smooth" });
    const r = $("c-req"); if (r) { r.placeholder = `¿Qué quieres decirle a ${b.dataset.mailTo}? (p. ej. «Paul no irá mañana, tiene médico»)`; r.focus(); }
  }));

  // datos clave y contactos
  box.querySelectorAll("[data-item-form]").forEach((f) => f.addEventListener("submit", (e) => {
    e.preventDefault();
    const label = f.elements.label.value.trim(), value = f.elements.value.value.trim(); if (!label) return;
    act(() => post(`/api/topics/${slug}/items`, { kind: f.dataset.itemForm, label, value }), "Guardado.");
  }));
  box.querySelectorAll("[data-item-del]").forEach((b) => b.addEventListener("click", () => act(() => post(`/api/items/${b.dataset.itemDel}`, {}, "DELETE"), "Quitado.")));

  // nueva tarea dentro del tema
  $("add-task")?.addEventListener("submit", (e) => {
    e.preventDefault(); const title = $("at-title").value.trim(); if (!title) return;
    act(() => post("/api/tasks", { title, topic: slug, due_date: $("at-due").value || null }), "Tarea añadida.");
  });

  // nuevo evento
  $("add-event")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = $("ae-title").value.trim(), date = $("ae-date").value;
    if (!title || !date) { say("Escribe el evento y su fecha.", true); return; }
    uiOpen["events-" + slug] = true;
    act(() => post(`/api/topics/${slug}/events`, { title, date, time: $("ae-time").value, place: $("ae-place").value }), "Evento añadido. Elige quién va y añádelo al calendario.");
  });

  // correos
  box.querySelectorAll("[data-mail]").forEach((b) => b.addEventListener("click", async () => {
    const id = +b.dataset.m, a = b.dataset.mail;
    if (a === "task") act(() => post(`/api/mails/${id}`, { action: "task" }), "Tarea creada.");
    if (a === "archive") act(() => post(`/api/mails/${id}`, { action: "archive" }), "Correo archivado.");
    if (a === "reply") { compose(slug, { mailId: id }); $("composer")?.scrollIntoView({ block: "start", behavior: "smooth" }); }
  }));

  // eventos
  // suscripciones
  $("sub-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("sf-name").value.trim(), amount = parseFloat($("sf-amount").value.replace(/\./g, "").replace(",", "."));
    if (!name || !(amount > 0)) { say("Escribe el nombre y un importe mayor que 0.", true); return; }
    uiOpen.gastos = true;
    const sub = $("sf-kind").value === "sub";
    act(() => post("/api/expenses", { name, amount, sub, cat: $("sf-cat").value, cycle: $("sf-cycle").value, next: $("sf-next").value, notice: $("sf-notice").value }), `«${name}» añadido.`);
  });
  box.querySelectorAll("[data-sub-del]").forEach((b) => b.addEventListener("click", () => act(() => post(`/api/expenses/${b.dataset.subDel}`, {}, "DELETE"), "Quitado.")));
  box.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => {
    compose(slug, { request: `Cancelar mi suscripción a «${b.dataset.cancel}» con efecto en la próxima renovación y pedir confirmación por escrito. Deja el destinatario en blanco.`, lang: "es" });
    $("composer")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }));

  // redactor
  $("c-form")?.addEventListener("submit", (e) => {
    e.preventDefault(); compose(slug, { request: $("c-req").value.trim(), lang: $("c-lang").value });
  });
  const dr = drafts[slug]; if (!dr || dr.stage === "loading") return;
  [["c-to", "to"], ["c-subj", "subject"], ["c-body", "body"]].forEach(([id, k]) => $(id)?.addEventListener("input", (e) => {
    dr[k] = e.target.value;
    const a = $("c-mailto"); if (a) a.href = `mailto:${encodeURIComponent(dr.to || "")}?subject=${encodeURIComponent(dr.subject)}&body=${encodeURIComponent(dr.body)}`;
  }));
  $("c-revise")?.addEventListener("submit", async (e) => {
    e.preventDefault(); const instruction = $("c-instr").value.trim(); if (!instruction) return;
    dr.working = true; dr.msg = "Aplicando los cambios…"; renderTopic(slug);
    try {
      const r = await post("/api/draft/revise", { subject: dr.subject, body: dr.body, lang: dr.lang, instruction });
      Object.assign(dr, { subject: r.subject, body: r.body, lang: r.lang, msg: `Cambiado: «${instruction}».` });
    } catch (err) { dr.msg = "⚠ " + err.message; }
    dr.working = false; renderTopic(slug);
  });
  $("composer")?.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]")?.dataset.act; if (!a) return;
    if (a === "copy") return copyText(`${dr.subject}\n\n${dr.body}`, e.target);
    if (a === "mark") { dr.stage = "confirm"; return renderTopic(slug); }
    if (a === "sent-no") { dr.stage = "draft"; return renderTopic(slug); }
    if (a === "discard" || a === "new") { delete drafts[slug]; return renderTopic(slug); }
    if (a === "sent-ok") {
      act(() => post("/api/draft/sent", { topic: slug, subject: dr.subject, to: dr.to, mailId: dr.mailId }), "Email anotado como enviado.")
        .then(() => { drafts[slug] = { stage: "sent" }; renderTopic(slug); }).catch(() => {});
    }
  });
  $("c-mailto")?.addEventListener("click", () => setTimeout(() => { dr.stage = "confirm"; renderTopic(slug); }, 800));
}

/* =========================================================
   NAVEGACIÓN
   ========================================================= */
function showTab(name) {
  if (name !== "tema") currentTopic = null;
  editingTopic = deletingTopic = sharingTopic = null; editingTask = null; invitingEv = editingEv = delEv = null; addingPanel = false; delPanel = null; addingContact = null; editingItem = null;
  $("tab-temas").hidden = name !== "temas";
  $("tab-tema").hidden = name !== "tema";
}
function openTopic(slug, { scrollTo } = {}) {
  currentTopic = slug; showTab("tema"); renderTopic(slug);
  (scrollTo ? $(scrollTo) : $("tab-tema"))?.scrollIntoView({ block: "start", behavior: "smooth" });
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-topic]");
  if (b && (b.closest("#groups") || b.closest("#alert-list"))) openTopic(b.dataset.topic);
});
$("back-topics").addEventListener("click", () => { showTab("temas"); renderAll(); window.scrollTo({ top: 0 }); });
/* ---------- eventos y calendario: acciones (portada y temas) ---------- */
document.addEventListener("click", (e) => {
  const t = e.target, q = (sel) => t.closest(sel);
  let b;
  if ((b = q("[data-cal-nav]"))) { const [y, m] = calMonth.split("-").map(Number); const d = new Date(y, m - 1 + +b.dataset.calNav, 1); calMonth = isoOf(d).slice(0, 7); return renderCalendar(); }
  if (q("[data-cal-today]")) { calMonth = null; calDay = null; return renderCalendar(); }
  if ((b = q("[data-cal-day]"))) { calDay = b.dataset.calDay; if (calDay.slice(0, 7) !== calMonth) calMonth = calDay.slice(0, 7); return renderCalendar(); }
  if ((b = q("[data-topic-open]"))) return openTopic(b.dataset.topicOpen);
  if ((b = q("[data-ev-expand]"))) { openEv.add(+b.dataset.evExpand); return renderAll(); }
  if ((b = q("[data-ev-collapse]"))) { openEv.delete(+b.dataset.evCollapse); return renderAll(); }
  if ((b = q("[data-ev-invite]"))) { invitingEv = +b.dataset.evInvite; editingEv = delEv = null; return renderAll(); }
  if (q("[data-ev-invite-cancel]")) { invitingEv = null; return renderAll(); }
  if ((b = q("[data-ev-invite-to]"))) {
    const id = +b.dataset.evInviteTo; invitingEv = null; openEv.delete(id); b.disabled = true;
    return act(() => post(`/api/events/${id}/invite`, { who: b.dataset.who }), (r) => `Invitación enviada a ${r.to.join(" y ")}. Le llegará por email para añadirla a su calendario.`).catch(() => {});
  }
  if ((b = q("[data-ev-edit]"))) { editingEv = +b.dataset.evEdit; invitingEv = delEv = null; return renderAll(); }
  if (q("[data-ev-edit-cancel]")) { editingEv = null; return renderAll(); }
  if ((b = q("[data-ev-del]"))) { delEv = +b.dataset.evDel; return renderAll(); }
  if ((b = q("[data-ev-del-ok]"))) { delEv = null; return act(() => post(`/api/events/${b.dataset.evDelOk}`, {}, "DELETE"), (r) => r.cancelled ? "Evento borrado y cancelación enviada." : "Evento borrado.").catch(() => {}); }
  if ((b = q("[data-ev-send]"))) return act(() => post(`/api/events/${b.dataset.evSend}`, { in_calendar: true }), "Añadido al calendario compartido.");
  if ((b = q("[data-ev-undo]"))) return act(() => post(`/api/events/${b.dataset.evUndo}`, { in_calendar: false }), "Quitado del calendario compartido.");
  if ((b = q("[data-open-ov]"))) { $("overview").open = true; }
});
document.addEventListener("change", (e) => {
  const id = e.target.dataset?.evAtt; if (!id) return;
  // «quién va» también decide si entra en el calendario compartido (.ics)
  const v = e.target.value;
  act(() => post(`/api/events/${id}`, { attendee: v, in_calendar: v === "g" || v === "s" || v === "b" }));
});
document.addEventListener("submit", (e) => {
  const f = e.target.closest("[data-cmt-form]"); if (!f) return;
  e.preventDefault(); const text = f.elements.text.value.trim(); if (!text) return;
  f.elements.text.value = "";
  act(() => post(`/api/tasks/${f.dataset.cmtForm}/comments`, { text }), "Comentario enviado.").catch(() => { f.elements.text.value = text; });
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-cmt-del]"); if (!b) return;
  act(() => post(`/api/comments/${b.dataset.cmtDel}`, {}, "DELETE"), "Comentario borrado.");
});
document.addEventListener("submit", (e) => {
  const f = e.target.closest("[data-ev-form]"); if (!f) return;
  e.preventDefault(); const id = f.dataset.evForm; editingEv = null;
  act(() => post(`/api/events/${id}`, { title: f.elements.title.value, date: f.elements.date.value, time: f.elements.time.value, place: f.elements.place.value, tz: f.elements.tz.value }, "PATCH"),
    (r) => r.updated ? "Evento cambiado y aviso enviado a los invitados." : "Evento cambiado.").catch(() => {});
});
document.addEventListener("click", (e) => {
  const ed = e.target.closest("[data-task-edit]");
  if (ed) { editingTask = +ed.dataset.taskEdit; pendingTaskDel = null; renderAll(); return; }
  if (e.target.closest("[data-task-edit-cancel]")) { editingTask = null; renderAll(); return; }
  const ask = e.target.closest("[data-ask]"); if (ask) { askClaude(+ask.dataset.ask); return; }
  const aiAct = e.target.closest("[data-ai-act]"); if (aiAct) { aiAct.disabled = true; runAction(+aiAct.dataset.aiAct, +aiAct.dataset.i); return; }
  const d = e.target.closest("[data-task-del]"), ok = e.target.closest("[data-task-del-ok]");
  if (d) { pendingTaskDel = +d.dataset.taskDel; renderAll(); if (currentTopic) renderTopic(currentTopic); }
  else if (ok) { pendingTaskDel = null; act(() => post(`/api/tasks/${ok.dataset.taskDelOk}`, {}, "DELETE"), "Tarea borrada."); }
  else if (pendingTaskDel && !e.target.closest(".tdel")) { pendingTaskDel = null; renderAll(); }
});
document.addEventListener("submit", (e) => {
  const f = e.target.closest("[data-task-form]"); if (!f) return;
  e.preventDefault();
  const id = f.dataset.taskForm, topic = f.elements.topic.value;
  const before = S.tasks.find((t) => t.id === +id);
  const moved = (before?.topic_id ?? null) !== (topicBySlug(topic)?.id ?? null);
  const ask = !!e.submitter?.hasAttribute("data-ask-on-save");
  if (!ask) editingTask = null;
  act(() => post(`/api/tasks/${id}`, { title: f.elements.title.value, topic: topic || null, due_date: f.elements.due.value || null, assignee: f.elements.assignee.value, notes: f.elements.notes.value }, "PATCH"),
    moved ? `Tarea movida a ${topic ? topicBySlug(topic).name : "Sin tema"}.` : "Tarea guardada.")
    .then(() => { if (ask) askClaude(+id); }).catch(() => {});
});
document.addEventListener("change", (e) => {
  const id = e.target.dataset?.task; if (!id) return;
  act(() => post(`/api/tasks/${id}`, { status: e.target.checked ? "done" : "open" }, "PATCH"));
});
["overview", "calendar"].forEach((id) => $(id).addEventListener("toggle", () => (uiOpen[id] = $(id).open)));

async function refresh(showMsg) {
  const b = $("refresh"); b.classList.add("spin");
  try {
    const before = S ? S.mails.length + S.tasks.length : 0;
    await load(); renderAll();
    if (showMsg) { const diff = S.mails.length + S.tasks.length - before; say(diff > 0 ? `Hay ${plural(diff, "entrada nueva", "entradas nuevas")}.` : "Todo al día: no ha llegado nada nuevo."); }
  } catch (e) { say("⚠ " + e.message, true); }
  b.classList.remove("spin");
}
$("refresh").addEventListener("click", () => refresh(true));
$("m-credit").addEventListener("click", () => { const f = $("credit-form"); f.hidden = !f.hidden; if (!f.hidden) $("cr-eur").focus(); });
$("cr-cancel").addEventListener("click", () => ($("credit-form").hidden = true));
$("credit-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const eur = parseFloat($("cr-eur").value.replace(/\./g, "").replace(",", "."));
  if (!(eur >= 0)) { say("Escribe el saldo en euros, por ejemplo 18,50.", true); return; }
  $("credit-form").hidden = true; $("cr-eur").value = "";
  act(() => post("/api/credit", { eur }, "PUT"), "Saldo actualizado.");
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S) refresh(false); });

/* ---------- entrada rápida ---------- */
const norm = (x) => x.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const ALIASES = { finanzas: /finanz|impuest/, "casa-valle": /valle/, "casa-berlin": /casa berlin|piso de berlin/, colegio: /colegio/, viajes: /viaje/, "rente-s": /sabrina/, "rente-g": /gonzalo/, documentos: /document|archivo|fichero/, eventos: /evento|cumple|familia/ };
function findTopic(text) {
  const n = norm(text);
  return S.topics.find((t) => n.includes(norm(t.name))) || S.topics.find((t) => ALIASES[t.slug]?.test(n));
}
$("quick").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("quick-text"), text = input.value.trim(); if (!text || !S) return;
  const t = findTopic(text);
  if (t && /^\s*(escr[ií]be|red[aá]cta|pr[eé]para)(me)?\b[^.]*\b(mail|email|e-mail|correo)\b/i.test(text)) {
    const lang = /ingl|english/i.test(text) ? "en" : /espa/i.test(text) ? "es" : /alem/i.test(text) ? "de" : undefined;
    input.value = ""; openTopic(t.slug, { scrollTo: "composer" });
    say(`Claude está escribiendo un borrador en ${t.name}…`);
    await compose(t.slug, { lang }); say(`Borrador listo en ${t.name}. Revísalo y decide qué hacer con él.`);
    return;
  }
  if (t && /^(abre|ver|muestra|ir a)\b/i.test(text)) { input.value = ""; openTopic(t.slug); return; }
  const btn = $("quick-btn"); btn.disabled = true; btn.textContent = "…";
  try {
    const r = await act(() => post("/api/inbox", { text }));
    input.value = "";
    say(r.kind === "task" ? `Tarea añadida a ${r.topic_name}${r.due_date ? ", para el " + fmt(r.due_date) : ""}.` : `Guardado en el historial de ${r.topic_name}.`);
  } catch { /* ya se muestra el error */ }
  btn.disabled = false; btn.textContent = "Enviar";
});

/* =========================================================
   VIAJE (dentro del tema Viajes; vuelos y tiempo de ejemplo)
   ========================================================= */
const tripPanel = $("trip-panel");
const CITIES = {
  lisboa: { name: "Lisboa", min: 9, max: 15, rain: 4, snow: false, h: "3 h 50", base: 140 },
  madrid: { name: "Madrid", min: 3, max: 11, rain: 2, snow: false, h: "3 h 15", base: 120 },
  tenerife: { name: "Tenerife", min: 16, max: 22, rain: 1, snow: false, h: "5 h 30", base: 210 },
  viena: { name: "Viena", min: -2, max: 3, rain: 3, snow: true, h: "1 h 10", base: 90 },
  londres: { name: "Londres", min: 4, max: 9, rain: 5, snow: false, h: "1 h 55", base: 110 },
};
$("dest").innerHTML = Object.entries(CITIES).map(([k, c]) => `<option value="${k}">${c.name}</option>`).join("");
const PEOPLE = [
  { key: "g", name: "Gonzalo", kind: "adulto", on: true },
  { key: "s", name: "Sabrina", kind: "adulto", on: true },
  { key: "h1", name: "Valentina", kind: "niño", age: 8, on: true },
  { key: "h2", name: "Paul", kind: "niño", age: 6, on: true },
  { key: "h3", name: "Santiago", kind: "niño", age: 3, on: true },
];
const trip = { flight: null };
const going = () => PEOPLE.filter((p) => p.on);
function renderTravelers() {
  $("travelers").innerHTML = PEOPLE.map((p) => `<div class="trav ${p.on ? "on" : ""}">
    <label for="tv-${p.key}"><input type="checkbox" id="tv-${p.key}" data-trav="${p.key}" ${p.on ? "checked" : ""}>${p.name}</label>
    ${p.kind === "niño" ? `<select id="tva-${p.key}" data-trav-age="${p.key}" aria-label="Edad de ${p.name}">${Array.from({ length: 18 }, (_, n) => `<option value="${n}" ${n === p.age ? "selected" : ""}>${n} años</option>`).join("")}</select>` : ""}
  </div>`).join("");
}
$("travelers").addEventListener("change", (e) => {
  e.stopPropagation();
  const k = e.target.dataset.trav, a = e.target.dataset.travAge;
  if (k) PEOPLE.find((p) => p.key === k).on = e.target.checked;
  if (a) PEOPLE.find((p) => p.key === a).age = +e.target.value;
  renderTravelers();
});
function goStep(n) {
  [1, 2, 3, 4].forEach((i) => ($("trip-" + i).hidden = i !== n));
  [...$("steps").children].forEach((s, i) => { s.classList.toggle("on", i === n - 1); s.classList.toggle("ok", i < n - 1); });
}
tripPanel.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => goStep(+b.dataset.back)));
const nights = () => Math.max(1, Math.round((new Date($("d2").value) - new Date($("d1").value)) / 864e5));
const payers = () => going().filter((p) => p.kind === "adulto" || p.age >= 2).length;
const whoGoes = () => going().map((p) => p.name + (p.kind === "niño" ? ` (${p.age})` : "")).join(", ");
$("search").addEventListener("click", () => {
  if (!going().length) { say("Marca al menos una persona.", true); return; }
  const c = CITIES[$("dest").value], babies = going().filter((p) => p.kind === "niño" && p.age < 2).length;
  trip.opts = [
    { label: "Directo", time: "07:10", dur: c.h, bag: "Solo equipaje de mano", p: c.base },
    { label: "Directo", time: "13:45", dur: c.h, bag: "Incluye 1 maleta facturada", p: Math.round(c.base * 1.35) },
    { label: "1 escala", time: "09:30", dur: "≈ 6 h", bag: "Incluye 1 maleta facturada", p: Math.round(c.base * 0.8) },
  ];
  trip.flight = null; $("to-book").disabled = true;
  $("flights-title").textContent = `Berlín → ${c.name} · ${fmt($("d1").value)} – ${fmt($("d2").value)} · ${whoGoes()}`;
  $("flights").innerHTML = trip.opts.map((o, i) => `<button type="button" class="card flight" data-f="${i}" style="background:var(--bg)">
    <div class="card-top"><div class="avatar">${o.label === "Directo" ? "D" : "1"}</div><span class="badge ${o.bag.startsWith("Solo") ? "mute" : ""}">${o.bag.startsWith("Solo") ? "Solo mano" : "Con maleta"}</span></div>
    <h3>Salida ${o.time}</h3><p>${o.label} · ${o.dur} · ${o.bag}</p>
    <div class="price">${o.p * payers()} €</div><div class="foot">${o.p} € × ${plural(payers(), "asiento", "asientos")}${babies ? ` · ${babies} bebé en brazos sin asiento` : ""}</div></button>`).join("");
  goStep(2);
});
$("flights").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]"); if (!b) return;
  trip.flight = trip.opts[+b.dataset.f];
  [...$("flights").children].forEach((x) => x.classList.toggle("sel", x === b));
  $("to-book").disabled = false;
});
$("to-book").addEventListener("click", () => {
  const c = CITIES[$("dest").value], f = trip.flight;
  $("book-summary").innerHTML = `<div class="card-top"><div class="avatar">${c.name[0]}</div><span class="badge warn">Por reservar</span></div>
    <h3>Berlín → ${c.name}</h3>
    <p>Salida ${fmt($("d1").value)} a las ${f.time}, vuelta ${fmt($("d2").value)}.<br>Viajan: ${esc(whoGoes())}.<br>${f.bag}.</p>
    <div class="price">${f.p * payers()} €</div><div class="foot">Total estimado</div>`;
  goStep(3);
});
function packFor(c, n, p) {
  const days = Math.min(n, 4), cold = c.min <= 5, warm = c.max >= 20, rain = c.rain >= 3, items = [];
  items.push(`${days + 1} mudas de ropa interior y calcetines`, `${days} camisetas`, `${cold ? 2 : 1} pantalón${cold ? "es" : ""} (más el puesto)`);
  if (cold) items.push("Abrigo de invierno (puesto en el viaje)", "1 jersey", "Gorro, guantes y bufanda");
  else if (!warm) items.push("Chaqueta ligera (puesta en el viaje)");
  if (c.snow) items.push("Botas impermeables (puestas)");
  if (warm) items.push("Bañador", "Gorra", "Protector solar (uno para todos)");
  if (rain) items.push(p.kind === "adulto" ? "Paraguas plegable" : "Chubasquero fino");
  items.push("Pijama");
  if (p.kind === "niño") {
    if (p.age < 2) items.push(`Pañales para ${n + 2} días`, "Toallitas", "Cambiador de viaje");
    if (p.age < 5) items.push("Muñeco para dormir"); else items.push("Un libro o juego para el avión");
  } else items.push("Documento de identidad", "Cargador del móvil");
  if (n > 4) items.push("Detergente en hojas o sobres (uno para todos)");
  return items;
}
$("booked").addEventListener("click", async () => {
  const c = CITIES[$("dest").value], d1 = $("d1").value, d2 = $("d2").value, n = nights();
  const handOnly = trip.flight.bag.startsWith("Solo");
  let r;
  try { r = await act(() => post("/api/trips/book", { dest: c.name, d1, d2, who: whoGoes(), count: going().length, handOnly })); } catch { return; }
  const people = going();
  const cold = c.min <= 5, perL = (cold ? 16 : 10) + Math.min(n, 4) * 2;
  const totalL = people.reduce((s, p) => s + (p.kind === "niño" ? (p.age < 2 ? perL * 0.8 : perL * 0.6) : perL), 0);
  const carry = Math.ceil(totalL / 40);
  const fitsCarry = carry <= payers();
  $("trip-ok").innerHTML = `<b>Viaje guardado.</b> En Tareas tienes el check-in online (${fmt(r.checkin)}) y hacer maletas (${fmt(r.pack)})${handOnly ? ", y añadir una maleta facturada si al final la necesitáis" : ""}.`;
  $("wx").innerHTML = `
    <div class="card" style="background:var(--bg)"><div class="card-top"><div class="avatar">${c.name[0]}</div><span class="badge ${cold ? "warn" : ""}">${cold ? "Frío" : c.max >= 20 ? "Calor" : "Templado"}</span></div>
      <h3>Tiempo habitual en ${c.name}</h3><div class="stat">${c.min}° / ${c.max}°</div>
      <p>Lluvia ${c.rain} de cada 8 días${c.snow ? ". Nieve probable" : ""}. Valores de ejemplo.</p></div>
    <div class="card" style="background:var(--bg)"><div class="card-top"><div class="avatar">M</div><span class="badge">${plural(people.length, "persona", "personas")} · ${plural(n, "noche", "noches")}</span></div>
      <h3>Equipaje mínimo</h3><div class="stat">${plural(carry, "maleta", "maletas")} de mano</div>
      <p>≈ ${Math.round(totalL)} litros en total. ${fitsCarry ? "Os basta con equipaje de mano, sin facturar." : "No cabe todo en mano: facturad una maleta grande."}${n > 4 ? " Se cuenta con poner una lavadora." : ""}</p></div>`;
  $("packing").innerHTML = people.map((p) => `<div class="card" style="background:var(--bg)">
    <div class="card-top"><div class="avatar">${p.name[0]}</div><span class="badge mute">${p.kind === "niño" ? p.age + " años" : "Adulto"}</span></div>
    <h3>${esc(p.name)}</h3>
    <ul class="checklist">${packFor(c, n, p).map((it, ii) => `<li><input type="checkbox" id="pk-${p.key}-${ii}"><label for="pk-${p.key}-${ii}">${esc(it)}</label></li>`).join("")}</ul></div>`).join("");
  goStep(4);
});

/* ---------- reordenar los temas: mantener pulsado y arrastrar (como los iconos del móvil) ---------- */
(() => {
  let press = null, drag = null, suppressClick = false;
  const grid = () => $("groups").querySelector(".topics-grid");
  const cardAt = (x, y) => document.elementFromPoint(x, y)?.closest(".topics-grid > .card.topic[data-topic]:not(.dragging)");

  function start(card, x, y, touch = false) {
    const r = card.getBoundingClientRect();
    const ph = document.createElement("div");
    ph.className = "card topic placeholder"; ph.style.height = r.height + "px";
    card.before(ph);
    Object.assign(card.style, { position: "fixed", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", zIndex: 60 });
    card.classList.add("dragging"); grid().classList.add("reordering");
    drag = { card, ph, dx: x - r.left, dy: y - r.top, before: order(), touch };
    navigator.vibrate?.(12);
  }
  function move(x, y) {
    const { card, ph, dx, dy } = drag;
    card.style.left = x - dx + "px"; card.style.top = y - dy + "px";
    const over = cardAt(x, y);
    if (over && over !== ph) {
      const after = ph.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING;
      after ? over.after(ph) : over.before(ph);
    }
    if (y < 70) window.scrollBy(0, -12); else if (y > innerHeight - 70) window.scrollBy(0, 12);
  }
  const order = () => [...grid().querySelectorAll(".card.topic[data-topic]:not(.dragging)")].map((c) => c.dataset.topic);
  function finish() {
    const { card, ph, before } = drag;
    ph.replaceWith(card); card.removeAttribute("style"); card.classList.remove("dragging");
    grid().classList.remove("reordering");
    drag = null; suppressClick = true; setTimeout(() => (suppressClick = false), 80);
    const now = order();
    if (now.join() === before.join()) return;
    S.topics.sort((a, b) => now.indexOf(a.slug) - now.indexOf(b.slug)); // ya se ve el nuevo orden
    post("/api/topics/order", { slugs: now }, "PUT").catch((e) => { say("⚠ No se pudo guardar el orden: " + e.message, true); refresh(false); });
  }
  const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };

  document.addEventListener("pointerdown", (e) => {
    const card = e.target.closest("#groups .topics-grid > .card.topic[data-topic]");
    if (!card || e.button > 0 || drag) return;
    press = { card, x: e.clientX, y: e.clientY, mouse: e.pointerType === "mouse" };
    // dedo: hay que mantener pulsado; ratón: basta con empezar a arrastrar
    if (!press.mouse) press.timer = setTimeout(() => { if (press) { start(press.card, press.x, press.y, true); press = null; } }, 420);
  });
  document.addEventListener("pointermove", (e) => {
    if (drag) { if (!drag.touch) { e.preventDefault(); move(e.clientX, e.clientY); } return; }
    if (!press) return;
    const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    if (press.mouse && dist > 6) { const p = press; press = null; start(p.card, p.x, p.y); move(e.clientX, e.clientY); }
    else if (!press.mouse && dist > 10) cancelPress(); // se está desplazando la página
  });
  document.addEventListener("pointerup", () => { cancelPress(); if (drag) finish(); });
  // Con el dedo, el arrastre sigue los eventos táctiles (el navegador puede cancelar los de puntero al desplazar)
  document.addEventListener("pointercancel", () => { cancelPress(); if (drag && !drag.touch) finish(); });
  document.addEventListener("touchmove", (e) => {
    if (press && !press.mouse) { const t = e.touches[0]; if (Math.hypot(t.clientX - press.x, t.clientY - press.y) > 10) cancelPress(); }
    if (!drag) return;
    e.preventDefault(); const t = e.touches[0]; move(t.clientX, t.clientY);
  }, { passive: false });
  document.addEventListener("touchend", () => { cancelPress(); if (drag) finish(); });
  document.addEventListener("contextmenu", (e) => { if (e.target.closest("#groups .card.topic")) e.preventDefault(); });
  document.addEventListener("click", (e) => { if (suppressClick && e.target.closest("#groups")) { e.stopPropagation(); e.preventDefault(); } }, true);
})();

/* ---------- alertas plegables en móvil (cada sesión empieza desplegada) ---------- */
$("alerts-toggle").addEventListener("click", () => {
  if (!matchMedia("(max-width: 900px)").matches) return;
  const c = $("alerts").classList.toggle("collapsed");
  $("alerts-toggle").setAttribute("aria-expanded", String(!c));
});

/* ---------- inicio ---------- */
renderTravelers();
(async () => {
  try { await load(); renderAll(); }
  catch (e) { $("groups").innerHTML = `<p class="loading">⚠ ${esc(e.message)}</p>`; }
})();
