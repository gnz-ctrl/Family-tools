import PostalMime from "postal-mime";
import { allowedSenders, getUser } from "./auth";
import { analyzeMail, assistTask, classify, draftEmail, reviseEmail } from "./claude";
import { ensureSchema, resetDemo } from "./db";
import { buildIcs, buildInvite, type CalEvent } from "./ics";
import type { Env, Topic, User } from "./types";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** Traduce los fallos más comunes a un mensaje que se pueda arreglar. */
function explainError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith("Claude API")) {
    if (/credit balance|billing/i.test(msg)) return "La cuenta de la API de Claude no tiene crédito. Añade saldo en console.anthropic.com → Billing.";
    if (/ 401/.test(msg)) return "La clave de la API de Claude no es válida. Revisa ANTHROPIC_API_KEY en Cloudflare.";
    if (/ 429/.test(msg)) return "Límite de uso de la API de Claude alcanzado. Prueba en un minuto.";
    if (/ 529| 503/.test(msg)) return "Claude está saturado en este momento. Prueba otra vez en un minuto.";
    return msg.slice(0, 400);
  }
  if (/ANTHROPIC_API_KEY/i.test(msg)) return "Falta la clave ANTHROPIC_API_KEY en Cloudflare.";
  return "Error interno: " + msg.slice(0, 300);
}

const MAX_FILE = 10 * 1024 * 1024;
const CHUNK = 90 * 1024; // trozos pequeños: D1 limita el tamaño de cada fila y de cada consulta

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

function users(env: Env): User[] {
  const emails = allowedSenders(env);
  const names = (env.USER_NAMES || "").split(",").map((s) => s.trim());
  const full = (env.USER_FULLNAMES || "").split(",").map((s) => s.trim());
  return emails.map((email, i) => ({ email, name: names[i] || email.split("@")[0], fullName: full[i] || names[i] || email }));
}
const signerFor = (env: Env, t: Topic, me: string) => {
  const u = users(env);
  return (u.find((x) => x.email === (t.owner || me)) ?? u[0]).fullName;
};

/** Temas que puede ver `me` (los compartidos y sus privados), con su color. Sin `me`: todos. */
async function getTopics(env: Env, me?: string): Promise<Topic[]> {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.slug, t.name, t.status_summary, t.next_step, t.email_lang, t.email_to, t.email_ref, t.owner, t.sort, t.private_to, c.color, pr.hidden
     FROM topics t LEFT JOIN topic_colors c ON c.topic_id = t.id AND c.email = ?1
     LEFT JOIN topic_prefs pr ON pr.topic_id = t.id AND pr.email = ?1
     WHERE ?1 IS NULL OR t.private_to IS NULL OR t.private_to = ?1 ORDER BY t.sort, t.id`,
  ).bind(me ?? null).all<Topic>();
  return results;
}
async function topicBySlug(env: Env, slug: string, me?: string): Promise<Topic> {
  const t = (await getTopics(env, me)).find((x) => x.slug === slug);
  if (!t) throw new HttpError(404, "Ese tema no existe");
  return t;
}
/** Condición SQL: la fila no tiene tema, o su tema es visible para ?1 */
const VISIBLE = `(topic_id IS NULL OR topic_id IN (SELECT id FROM topics WHERE private_to IS NULL OR private_to = ?1))`;
/** Comprueba que una fila (tarea, correo, evento, dato) pertenece a un tema que `me` puede ver. */
async function guard(env: Env, table: "tasks" | "mails" | "events" | "topic_items" | "topic_panels", id: string | number, me: string) {
  const r = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?2 AND ${VISIBLE}`).bind(me, Number(id)).first();
  if (!r) throw new HttpError(404, "Eso ya no existe");
}
const addHistory = (env: Env, topicId: number, text: string, source = "web") =>
  env.DB.prepare(`INSERT INTO history (topic_id, at, text, source) VALUES (?, date('now'), ?, ?)`).bind(topicId, text, source).run();

/** Saldo estimado de la API: lo que pusiste al recargar menos lo gastado desde entonces (en €). */
async function apiCredit(env: Env) {
  const { results } = await env.DB.prepare(`SELECT k, v FROM settings WHERE k IN ('credit_eur', 'api_spent_usd', 'usd_eur', 'usd_eur_at')`).all<{ k: string; v: string }>();
  const g = Object.fromEntries(results.map((r) => [r.k, r.v]));
  let rate = Number(g.usd_eur) || 0.86;
  if (g.usd_eur_at !== today()) {
    // tipo de cambio del BCE, una vez al día (si falla se usa el último conocido)
    try {
      const r = await fetch("https://api.frankfurter.app/latest?from=USD&to=EUR", { signal: AbortSignal.timeout(2500) });
      const j = (await r.json()) as { rates?: { EUR?: number } };
      if (j.rates?.EUR) rate = j.rates.EUR;
    } catch { /* sin conexión: seguimos con el anterior */ }
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO settings (k, v) VALUES ('usd_eur', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(String(rate)),
      env.DB.prepare(`INSERT INTO settings (k, v) VALUES ('usd_eur_at', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(today()),
    ]);
  }
  const spentEur = (Number(g.api_spent_usd) || 0) * rate;
  return g.credit_eur == null ? { left: null, spent: spentEur } : { left: Number(g.credit_eur) - spentEur, spent: spentEur };
}

/* ---------- invitaciones de calendario por email ---------- */
type EvRow = CalEvent & { topic_id: number | null; invited: string | null };
const loadEvent = (env: Env, id: number) => env.DB.prepare(
  `SELECT e.id, e.topic_id, e.title, e.date, e.time, e.place, e.note, e.who, e.attendee, e.invited, e.seq, t.name AS topic FROM events e LEFT JOIN topics t ON t.id = e.topic_id WHERE e.id = ?`,
).bind(id).first<EvRow>();
/** "g" → Gonzalo, "s" → Sabrina (por la inicial del nombre), "b" → los dos */
function recipients(env: Env, who: string): User[] {
  const u = users(env);
  if (who === "b") return u;
  return u.filter((x) => x.name.toLowerCase().startsWith(who));
}
const b64 = (s: string) => { const bytes = new TextEncoder().encode(s); let bin = ""; bytes.forEach((b) => (bin += String.fromCharCode(b))); return btoa(bin); };
async function sendInvite(env: Env, ev: CalEvent, method: "REQUEST" | "CANCEL", to: User[], fromName: string, update = false) {
  if (!to.length) return;
  const from = env.MAIL_FROM || "calendario@sbkperez.me";
  const ics = buildInvite(ev, method, { email: from, name: "Family Hub" }, to);
  const fecha = new Date(ev.date + "T12:00:00Z").toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const linea = `${ev.title} · ${fecha}${ev.time ? `, ${ev.time}` : ""}${ev.place ? ` · ${ev.place}` : ""}`;
  const subject = method === "CANCEL" ? `Cancelado: ${ev.title}` : `${update ? "Cambio" : "Invitación"}: ${ev.title} (${fecha}${ev.time ? `, ${ev.time}` : ""})`;
  const intro = method === "CANCEL" ? `${fromName} ha cancelado este evento:` : update ? `${fromName} ha cambiado este evento:` : `${fromName} te invita a:`;
  const text = `${intro}\n\n${linea}${ev.note ? `\n${ev.note}` : ""}\n\n${method === "CANCEL" ? "Si ya estaba en tu calendario, se quitará al abrir este correo." : "Ábrelo en tu calendario o responde Sí / No desde la tarjeta del evento."}\n\n— Family Hub · sbkperez.me`;
  const html = `<p>${esc(intro)}</p><p style="font-size:16px"><b>${esc(ev.title)}</b><br>${esc(fecha)}${ev.time ? `, ${esc(ev.time)}` : ""}${ev.place ? `<br>${esc(ev.place)}` : ""}${ev.note ? `<br><i>${esc(ev.note)}</i>` : ""}</p><p style="color:#5b6672">— Family Hub · <a href="https://sbkperez.me">sbkperez.me</a></p>`;
  if (env.DEV_MODE === "true" || !env.EMAIL) { console.log(`[email simulado] ${subject} → ${to.map((u) => u.email).join(", ")}\n${ics}`); return; }
  await env.EMAIL.send({
    from, to: to.map((u) => u.email), subject, text, html,
    attachments: [{ filename: method === "CANCEL" ? "cancelacion.ics" : "invitacion.ics", content: b64(ics), type: `text/calendar; charset=utf-8; method=${method}`, disposition: "attachment" }],
  });
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const nameOf = (env: Env, email: string) => users(env).find((u) => u.email === email)?.name || email;

/** Todo lo que necesita la web, en una sola llamada. */
async function state(env: Env, me: string) {
  const [topics, items, history, tasks, mails, events, expenses, cal, files, panels, credit, comments] = await Promise.all([
    getTopics(env, me),
    env.DB.prepare(`SELECT id, topic_id, kind, label, value, extra FROM topic_items WHERE ${VISIBLE} ORDER BY sort, id`).bind(me).all(),
    env.DB.prepare(`SELECT id, topic_id, at, text, source FROM history WHERE ${VISIBLE} ORDER BY at DESC, id DESC`).bind(me).all(),
    env.DB.prepare(`SELECT id, title, notes, topic_id, assignee, due_date, status, source, created_at, completed_at, completed_by, ai FROM tasks WHERE ${VISIBLE} ORDER BY id`).bind(me).all(),
    env.DB.prepare(`SELECT id, topic_id, from_name, from_addr, subject, lang, received_at, intent, todo, due, state, forwarded_by FROM mails WHERE state != 'archived' AND ${VISIBLE} ORDER BY received_at DESC, id DESC`).bind(me).all(),
    env.DB.prepare(`SELECT id, topic_id, mail_id, title, date, time, who, place, note, attendee, in_calendar, invited, rsvp, seq FROM events WHERE ${VISIBLE} ORDER BY date, id`).bind(me).all(),
    env.DB.prepare(`SELECT id, name, cat, amount, cycle, next, notice, sub, flag FROM expenses ORDER BY id`).all(),
    env.DB.prepare(`SELECT v FROM settings WHERE k = 'cal_token'`).first<{ v: string }>(),
    env.DB.prepare(`SELECT id, name, type, size, uploaded_by, created_at FROM files ORDER BY created_at DESC, id DESC`).all(),
    env.DB.prepare(`SELECT id, topic_id, title, body FROM topic_panels WHERE ${VISIBLE} ORDER BY sort, id`).bind(me).all(),
    apiCredit(env),
    env.DB.prepare(`SELECT id, task_id, author, text, at FROM task_comments WHERE task_id IN (SELECT id FROM tasks WHERE ${VISIBLE}) ORDER BY at, id`).bind(me).all(),
  ]);
  return {
    me, today: today(), users: users(env), topics,
    items: items.results, history: history.results, tasks: tasks.results,
    mails: mails.results, events: events.results, expenses: expenses.results,
    files: files.results, panels: panels.results, credit, comments: comments.results,
    calPath: cal ? `/cal/${cal.v}.ics` : null,
  };
}

/** Entrada libre (web o todo@): Claude la convierte en tarea o nota. */
const workTopics = async (env: Env, who: string) => (await getTopics(env, who)).filter((t) => t.slug !== "documentos");

async function ingest(env: Env, opts: { text: string; sender: string; source: "web" | "email"; subject?: string }) {
  const topics = await workTopics(env, opts.sender);
  const r = await classify(env, {
    text: opts.subject ? `Asunto: ${opts.subject}\n\n${opts.text}` : opts.text,
    sender: opts.sender, topics, users: allowedSenders(env), today: today(),
  });
  await env.DB.prepare(`INSERT INTO inbox_items (source, sender, subject, body, ai_result) VALUES (?, ?, ?, ?, ?)`)
    .bind(opts.source, opts.sender, opts.subject ?? null, opts.text, JSON.stringify(r)).run();
  const topic = topics.find((t) => t.slug === r.topic_slug) ?? null;
  if (r.topic_status_update && topic) {
    await env.DB.prepare(`UPDATE topics SET status_summary = ?, updated_at = datetime('now') WHERE id = ?`).bind(r.topic_status_update, topic.id).run();
  }
  if (r.kind === "event" && r.due_date) {
    await env.DB.prepare(`INSERT INTO events (topic_id, title, date, time, place, note) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(topic?.id ?? null, r.title, r.due_date, r.event_time || null, r.place || null, r.notes || null).run();
  } else if (r.kind === "task" || r.kind === "event") {
    await env.DB.prepare(`INSERT INTO tasks (title, notes, topic_id, assignee, due_date, source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(r.title, r.notes ?? null, topic?.id ?? null, r.assignee || opts.sender, r.due_date || null, opts.source, opts.sender).run();
  } else if (topic) {
    await addHistory(env, topic.id, r.title, opts.source);
  }
  return { ...r, topic_name: topic?.name ?? "Sin tema" };
}

/** Correo reenviado a inbox@: resumen, tema, plazo y eventos. */
async function ingestMail(env: Env, opts: { subject: string; text: string; forwardedBy: string }) {
  const topics = await workTopics(env, opts.forwardedBy);
  const a = await analyzeMail(env, { ...opts, topics, today: today() });
  const topic = topics.find((t) => t.slug === a.topic_slug) ?? null;
  const row = await env.DB.prepare(
    `INSERT INTO mails (topic_id, from_name, from_addr, subject, lang, intent, todo, due, body, forwarded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(topic?.id ?? null, a.from_name || "Desconocido", a.from_addr || null, a.subject || opts.subject, a.lang || null,
    a.intent || null, a.todo || null, a.due || null, opts.text.slice(0, 20000), opts.forwardedBy).first<{ id: number }>();
  for (const ev of a.events ?? []) {
    if (!ev.title || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date || "")) continue;
    await env.DB.prepare(`INSERT INTO events (topic_id, mail_id, title, date, time, who, place, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(topic?.id ?? null, row?.id ?? null, ev.title, ev.date, ev.time || null, ev.who || null, ev.place || null, ev.note || null).run();
  }
  if (topic) await addHistory(env, topic.id, `Correo recibido de ${a.from_name}: ${a.subject || opts.subject}`, "email");
  return a;
}

async function topicContext(env: Env, t: Topic) {
  const { results: facts } = await env.DB.prepare(`SELECT kind, label, value FROM topic_items WHERE topic_id = ? AND kind != 'doc' ORDER BY sort`).bind(t.id).all<{ kind: string; label: string; value: string }>();
  const { results: hist } = await env.DB.prepare(`SELECT at, text FROM history WHERE topic_id = ? ORDER BY at DESC LIMIT 8`).bind(t.id).all<{ at: string; text: string }>();
  return [
    t.status_summary && `Estado actual: ${t.status_summary}`,
    t.next_step && `Próximo paso: ${t.next_step}`,
    t.email_ref && `Referencia: ${t.email_ref}`,
    facts.length && "Datos:\n" + facts.map((f) => `- ${f.label}: ${f.value}`).join("\n"),
    hist.length && "Historial reciente:\n" + hist.map((h) => `- ${h.at}: ${h.text}`).join("\n"),
  ].filter(Boolean).join("\n");
}

/* ------------------------------------------------------------------------------------------ */

async function handleApi(req: Request, env: Env, me: string): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname, m = req.method;
  const body = async <T>() => (m === "GET" ? {} : await req.json().catch(() => ({}))) as T;
  let mm: RegExpMatchArray | null;

  if (p === "/api/state" && m === "GET") return json(await state(env, me));

  if (p === "/api/inbox" && m === "POST") {
    const { text } = await body<{ text?: string }>();
    if (!text?.trim()) throw new HttpError(400, "Escribe algo primero");
    return json(await ingest(env, { text, sender: me, source: "web" }));
  }

  if ((mm = p.match(/^\/api\/tasks\/(\d+)$/)) && m === "PATCH") {
    await guard(env, "tasks", mm[1], me);
    const b = await body<{ status?: string; topic?: string | null; title?: string; due_date?: string | null; assignee?: string; notes?: string }>();
    if (b.notes !== undefined) await env.DB.prepare(`UPDATE tasks SET notes = ? WHERE id = ?`).bind(b.notes.trim().slice(0, 4000) || null, mm[1]).run();
    if (b.status === "done") await env.DB.prepare(`UPDATE tasks SET status='done', completed_at=date('now'), completed_by=? WHERE id=?`).bind(me, mm[1]).run();
    else if (b.status === "open") await env.DB.prepare(`UPDATE tasks SET status='open', completed_at=NULL, completed_by=NULL WHERE id=?`).bind(mm[1]).run();
    if (b.topic !== undefined) {
      const t = b.topic ? await topicBySlug(env, b.topic, me) : null;
      await env.DB.prepare(`UPDATE tasks SET topic_id = ? WHERE id = ?`).bind(t?.id ?? null, mm[1]).run();
    }
    if (b.title !== undefined && b.title.trim()) await env.DB.prepare(`UPDATE tasks SET title = ? WHERE id = ?`).bind(b.title.trim(), mm[1]).run();
    if (b.due_date !== undefined) await env.DB.prepare(`UPDATE tasks SET due_date = ? WHERE id = ?`).bind(b.due_date && /^\d{4}-\d{2}-\d{2}$/.test(b.due_date) ? b.due_date : null, mm[1]).run();
    if (b.assignee !== undefined && b.assignee) await env.DB.prepare(`UPDATE tasks SET assignee = ? WHERE id = ?`).bind(b.assignee, mm[1]).run();
    return json({ ok: true });
  }

  if ((mm = p.match(/^\/api\/topics\/([\w-]+)\/note$/)) && m === "POST") {
    const { text } = await body<{ text?: string }>();
    if (!text?.trim()) throw new HttpError(400, "La nota está vacía");
    const t = await topicBySlug(env, mm[1], me);
    await addHistory(env, t.id, text.trim());
    await env.DB.prepare(`UPDATE topics SET status_summary = ?, updated_at = datetime('now') WHERE id = ?`).bind(text.trim().replace(/\.?$/, "."), t.id).run();
    return json({ ok: true });
  }

  if ((mm = p.match(/^\/api\/mails\/(\d+)$/)) && m === "POST") {
    const { action } = await body<{ action?: string }>();
    await guard(env, "mails", mm[1], me);
    const mail = await env.DB.prepare(`SELECT * FROM mails WHERE id = ?`).bind(mm[1]).first<{ id: number; topic_id: number; todo: string; due: string; state: string }>();
    if (!mail) throw new HttpError(404, "Ese correo ya no existe");
    if (action === "task") {
      await env.DB.prepare(`INSERT INTO tasks (title, topic_id, assignee, due_date, source, created_by) VALUES (?, ?, ?, ?, 'email', ?)`).bind(mail.todo || "Revisar correo", mail.topic_id, me, mail.due, me).run();
      await env.DB.prepare(`UPDATE mails SET state = 'task' WHERE id = ?`).bind(mail.id).run();
    } else if (action === "archive") {
      await env.DB.prepare(`UPDATE mails SET state = 'archived' WHERE id = ?`).bind(mail.id).run();
    } else if (action === "replied") {
      await env.DB.prepare(`UPDATE mails SET state = 'done' WHERE id = ?`).bind(mail.id).run();
    } else throw new HttpError(400, "Acción desconocida");
    return json({ ok: true });
  }

  if ((mm = p.match(/^\/api\/events\/(\d+)$/)) && m === "POST") {
    const { attendee, in_calendar } = await body<{ attendee?: string; in_calendar?: boolean }>();
    await guard(env, "events", mm[1], me);
    const ev = await env.DB.prepare(`SELECT id, topic_id, title, date FROM events WHERE id = ?`).bind(mm[1]).first<{ id: number; topic_id: number; title: string; date: string }>();
    if (!ev) throw new HttpError(404, "Ese evento ya no existe");
    if (attendee !== undefined) await env.DB.prepare(`UPDATE events SET attendee = ? WHERE id = ?`).bind(attendee || null, ev.id).run();
    if (in_calendar !== undefined) {
      await env.DB.prepare(`UPDATE events SET in_calendar = ? WHERE id = ?`).bind(in_calendar ? 1 : 0, ev.id).run();
      if (in_calendar && ev.topic_id) await addHistory(env, ev.topic_id, `Al calendario: ${ev.title} (${ev.date})`);
    }
    return json({ ok: true });
  }

  if (p === "/api/draft" && m === "POST") {
    const { topic, request, lang, mailId } = await body<{ topic: string; request?: string; lang?: string; mailId?: number }>();
    const t = await topicBySlug(env, topic, me);
    let replyTo: { from: string; subject: string; intent: string; todo: string; addr: string } | undefined;
    if (mailId) {
      await guard(env, "mails", mailId, me);
      const mail = await env.DB.prepare(`SELECT from_name, from_addr, subject, intent, todo FROM mails WHERE id = ?`).bind(mailId).first<{ from_name: string; from_addr: string; subject: string; intent: string; todo: string }>();
      if (mail) replyTo = { from: mail.from_name, subject: mail.subject, intent: mail.intent, todo: mail.todo, addr: mail.from_addr };
    }
    const l = lang || t.email_lang || "de";
    const d = await draftEmail(env, { topic: t, context: await topicContext(env, t), request: request || "", lang: l, signer: signerFor(env, t, me), replyTo });
    return json({ ...d, to: replyTo?.addr || t.email_to || "" });
  }

  if (p === "/api/draft/revise" && m === "POST") {
    const b = await body<{ subject: string; body: string; lang: string; instruction: string }>();
    if (!b.instruction?.trim()) throw new HttpError(400, "Escribe qué quieres cambiar");
    return json(await reviseEmail(env, b));
  }

  if (p === "/api/draft/sent" && m === "POST") {
    const { topic, subject, to, mailId } = await body<{ topic: string; subject: string; to?: string; mailId?: number }>();
    const t = await topicBySlug(env, topic, me);
    await addHistory(env, t.id, `Email enviado${to ? ` a ${to}` : ""}: «${subject}»`);
    await env.DB.prepare(`INSERT INTO tasks (title, topic_id, assignee, due_date, created_by) VALUES (?, ?, ?, ?, ?)`)
      .bind(`Revisar si han respondido: ${subject}`, t.id, me, addDays(14), me).run();
    if (mailId) await env.DB.prepare(`UPDATE mails SET state = 'done' WHERE id = ?`).bind(mailId).run();
    return json({ ok: true });
  }

  if (p === "/api/expenses" && m === "POST") {
    const e = await body<{ name?: string; amount?: number; cycle?: string; next?: string; notice?: string; sub?: boolean; cat?: string }>();
    if (!e.name?.trim() || !(Number(e.amount) > 0)) throw new HttpError(400, "Escribe el nombre y un importe mayor que 0");
    const cycle = ["mes", "trimestre", "año"].includes(e.cycle || "") ? e.cycle : "mes";
    const cat = e.sub ? "Ocio y suscripciones" : (e.cat?.trim() || "Otros");
    await env.DB.prepare(`INSERT INTO expenses (name, cat, amount, cycle, next, notice, sub) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(e.name.trim(), cat, Number(e.amount), cycle, e.next || null, e.notice?.trim() || (e.sub ? "En cualquier momento" : null), e.sub ? 1 : 0).run();
    const t = await topicBySlug(env, "finanzas", me).catch(() => null);
    if (t) await addHistory(env, t.id, `${e.sub ? "Suscripción" : "Gasto fijo"} añadido: ${e.name.trim()}`);
    return json({ ok: true });
  }

  /* --- saldo de la API (lo introduce la familia al recargar) --- */
  if (p === "/api/credit" && m === "PUT") {
    const { eur } = await body<{ eur?: number }>();
    if (!(Number(eur) >= 0)) throw new HttpError(400, "Escribe el saldo en euros");
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO settings (k, v) VALUES ('credit_eur', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(String(Number(eur))),
      env.DB.prepare(`UPDATE settings SET v = '0' WHERE k = 'api_spent_usd'`),
    ]);
    return json({ ok: true });
  }

  /* --- paneles de cada tema --- */
  if ((mm = p.match(/^\/api\/topics\/([\w-]+)\/hidden$/)) && m === "PUT") {
    const t = await topicBySlug(env, mm[1], me);
    const { hidden } = await body<{ hidden?: string[] }>();
    const list = (hidden || []).filter((x) => /^[a-z]{2,12}$/.test(x)).slice(0, 20);
    await env.DB.prepare(`INSERT INTO topic_prefs (email, topic_id, hidden) VALUES (?, ?, ?) ON CONFLICT (email, topic_id) DO UPDATE SET hidden = excluded.hidden`)
      .bind(me, t.id, JSON.stringify(list)).run();
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/topics\/([\w-]+)\/panels$/)) && m === "POST") {
    const t = await topicBySlug(env, mm[1], me);
    const { title } = await body<{ title?: string }>();
    if (!title?.trim()) throw new HttpError(400, "Escribe el nombre del panel");
    const r = await env.DB.prepare(`INSERT INTO topic_panels (topic_id, title, body, sort) VALUES (?, ?, '', (SELECT COALESCE(MAX(sort), 0) + 1 FROM topic_panels)) RETURNING id`)
      .bind(t.id, title.trim().slice(0, 60)).first<{ id: number }>();
    return json({ ok: true, id: r?.id });
  }
  if ((mm = p.match(/^\/api\/panels\/(\d+)$/)) && m === "PATCH") {
    await guard(env, "topic_panels", mm[1], me);
    const b = await body<{ title?: string; body?: string }>();
    if (b.title?.trim()) await env.DB.prepare(`UPDATE topic_panels SET title = ? WHERE id = ?`).bind(b.title.trim().slice(0, 60), Number(mm[1])).run();
    if (b.body !== undefined) await env.DB.prepare(`UPDATE topic_panels SET body = ? WHERE id = ?`).bind(b.body.slice(0, 20000), Number(mm[1])).run();
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/panels\/(\d+)$/)) && m === "DELETE") {
    await guard(env, "topic_panels", mm[1], me);
    await env.DB.prepare(`DELETE FROM topic_panels WHERE id = ?`).bind(Number(mm[1])).run();
    return json({ ok: true });
  }

  /* --- temas --- */
  if (p === "/api/topics" && m === "POST") {
    const { name, private: priv } = await body<{ name?: string; private?: boolean }>();
    const n = name?.trim().slice(0, 60);
    if (!n) throw new HttpError(400, "Escribe el nombre del tema");
    const base = n.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tema";
    const taken = new Set((await getTopics(env)).map((t) => t.slug));
    let slug = base, i = 2; while (taken.has(slug)) slug = `${base}-${i++}`;
    await env.DB.prepare(`INSERT INTO topics (slug, name, private_to, sort) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM topics))`).bind(slug, n, priv ? me : null).run();
    return json({ ok: true, slug });
  }
  if ((mm = p.match(/^\/api\/topics\/([\w-]+)\/share$/)) && m === "POST") {
    const t = await topicBySlug(env, mm[1], me);
    if (t.private_to !== me) throw new HttpError(400, "Este tema ya es compartido");
    await env.DB.prepare(`UPDATE topics SET private_to = NULL WHERE id = ?`).bind(t.id).run();
    const name = users(env).find((u) => u.email === me)?.name || me;
    await addHistory(env, t.id, `${name} ha compartido este tema con los dos`);
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/topics\/([\w-]+)\/color$/)) && m === "PUT") {
    const t = await topicBySlug(env, mm[1], me);
    const { color } = await body<{ color?: string }>();
    if (!color) await env.DB.prepare(`DELETE FROM topic_colors WHERE email = ? AND topic_id = ?`).bind(me, t.id).run();
    else if (/^[a-z]{3,12}$/.test(color)) await env.DB.prepare(`INSERT INTO topic_colors (email, topic_id, color) VALUES (?, ?, ?) ON CONFLICT (email, topic_id) DO UPDATE SET color = excluded.color`).bind(me, t.id, color).run();
    else throw new HttpError(400, "Color no válido");
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/topics\/([\w-]+)$/)) && m === "PATCH") {
    const t = await topicBySlug(env, mm[1], me);
    const b = await body<{ name?: string; status_summary?: string; next_step?: string; email_to?: string; email_lang?: string }>();
    const v = (x: string | undefined, old: string | null) => (x === undefined ? old : x.trim() || null);
    const name = b.name?.trim() ? b.name.trim().slice(0, 60) : t.name;
    await env.DB.prepare(`UPDATE topics SET name = ?, status_summary = ?, next_step = ?, email_to = ?, email_lang = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(name, v(b.status_summary, t.status_summary), v(b.next_step, t.next_step), v(b.email_to, t.email_to), v(b.email_lang, t.email_lang), t.id).run();
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/topics\/([\w-]+)$/)) && m === "DELETE") {
    const t = await topicBySlug(env, mm[1], me);
    if (t.slug === "documentos") throw new HttpError(400, "Documentos compartidos no se puede borrar");
    await env.DB.batch([
      // en un tema privado las tareas se borran (si no, pasarían a verse por los dos)
      ...(t.private_to ? [env.DB.prepare(`DELETE FROM task_comments WHERE task_id IN (SELECT id FROM tasks WHERE topic_id = ?)`).bind(t.id)] : []),
      env.DB.prepare(t.private_to ? `DELETE FROM tasks WHERE topic_id = ?` : `UPDATE tasks SET topic_id = NULL WHERE topic_id = ?`).bind(t.id),
      env.DB.prepare(`DELETE FROM topic_colors WHERE topic_id = ?`).bind(t.id),
      env.DB.prepare(`DELETE FROM topic_prefs WHERE topic_id = ?`).bind(t.id),
      env.DB.prepare(`DELETE FROM topic_panels WHERE topic_id = ?`).bind(t.id),
      env.DB.prepare(`DELETE FROM topic_items WHERE topic_id = ?`).bind(t.id),
      env.DB.prepare(`DELETE FROM history WHERE topic_id = ?`).bind(t.id),
      env.DB.prepare(`DELETE FROM events WHERE topic_id = ?`).bind(t.id),
      env.DB.prepare(`DELETE FROM mails WHERE topic_id = ?`).bind(t.id),
      env.DB.prepare(`DELETE FROM topics WHERE id = ?`).bind(t.id),
    ]);
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/topics\/([\w-]+)\/items$/)) && m === "POST") {
    const t = await topicBySlug(env, mm[1], me);
    const { kind, label, value, extra } = await body<{ kind?: string; label?: string; value?: string; extra?: string }>();
    if (!["fact", "contact"].includes(kind || "") || !label?.trim()) throw new HttpError(400, "Escribe al menos el nombre");
    await env.DB.prepare(`INSERT INTO topic_items (topic_id, kind, label, value, extra, sort) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM topic_items))`)
      .bind(t.id, kind, label.trim(), value?.trim() || "", extra ? String(extra).slice(0, 500) : null).run();
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/items\/(\d+)$/)) && m === "DELETE") {
    await guard(env, "topic_items", mm[1], me);
    await env.DB.prepare(`DELETE FROM topic_items WHERE id = ?`).bind(mm[1]).run();
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/topics\/([\w-]+)\/events$/)) && m === "POST") {
    const t = await topicBySlug(env, mm[1], me);
    const e = await body<{ title?: string; date?: string; time?: string; place?: string; who?: string; note?: string }>();
    if (!e.title?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || "")) throw new HttpError(400, "Escribe el nombre y la fecha del evento");
    await env.DB.prepare(`INSERT INTO events (topic_id, title, date, time, place, who, note) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(t.id, e.title.trim(), e.date, e.time?.trim() || null, e.place?.trim() || null, e.who?.trim() || null, e.note?.trim() || null).run();
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/events\/(\d+)$/)) && m === "DELETE") {
    await guard(env, "events", mm[1], me);
    const ev = await loadEvent(env, Number(mm[1]));
    const invited: string[] = ev?.invited ? JSON.parse(ev.invited) : [];
    if (ev && invited.length) {
      try { await sendInvite(env, { ...ev, seq: (ev.seq ?? 0) + 1 }, "CANCEL", users(env).filter((u) => invited.includes(u.email)), nameOf(env, me)); }
      catch (e) { console.error("cancelación no enviada", e); }
    }
    await env.DB.prepare(`DELETE FROM events WHERE id = ?`).bind(mm[1]).run();
    return json({ ok: true, cancelled: invited.length });
  }
  // Editar un evento; si ya había invitados, les llega el cambio
  if ((mm = p.match(/^\/api\/events\/(\d+)$/)) && m === "PATCH") {
    await guard(env, "events", mm[1], me);
    const b = await body<{ title?: string; date?: string; time?: string; place?: string; note?: string }>();
    if (b.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) throw new HttpError(400, "Fecha no válida");
    const old = await loadEvent(env, Number(mm[1]));
    if (!old) throw new HttpError(404, "Ese evento ya no existe");
    const nv = {
      title: b.title?.trim() || old.title, date: b.date || old.date,
      time: b.time !== undefined ? b.time.trim() || null : old.time, place: b.place !== undefined ? b.place.trim() || null : old.place,
      note: b.note !== undefined ? b.note.trim() || null : old.note,
    };
    await env.DB.prepare(`UPDATE events SET title = ?, date = ?, time = ?, place = ?, note = ?, seq = seq + 1 WHERE id = ?`)
      .bind(nv.title, nv.date, nv.time, nv.place, nv.note, old.id).run();
    const invited: string[] = old.invited ? JSON.parse(old.invited) : [];
    if (invited.length) await sendInvite(env, { ...old, ...nv, seq: (old.seq ?? 0) + 1 }, "REQUEST", users(env).filter((u) => invited.includes(u.email)), nameOf(env, me), true);
    return json({ ok: true, updated: invited.length });
  }
  // Invitar por email a Gonzalo, Sabrina o los dos
  if ((mm = p.match(/^\/api\/events\/(\d+)\/invite$/)) && m === "POST") {
    await guard(env, "events", mm[1], me);
    const { who } = await body<{ who?: string }>();
    const to = recipients(env, who || "b");
    if (!to.length) throw new HttpError(400, "Elige a quién invitar");
    const ev = await loadEvent(env, Number(mm[1]));
    if (!ev) throw new HttpError(404, "Ese evento ya no existe");
    const before: string[] = ev.invited ? JSON.parse(ev.invited) : [];
    try { await sendInvite(env, ev, "REQUEST", to, nameOf(env, me), before.some((e) => to.some((u) => u.email === e))); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/RECIPIENT|destination|verified/i.test(msg)) throw new HttpError(400, "Cloudflare no deja enviar a esa dirección: verifica las dos direcciones en Email Routing → Destination addresses.");
      throw e;
    }
    const all = [...new Set([...before, ...to.map((u) => u.email)])];
    await env.DB.prepare(`UPDATE events SET invited = ? WHERE id = ?`).bind(JSON.stringify(all), ev.id).run();
    if (ev.topic_id) await addHistory(env, ev.topic_id, `Invitación enviada a ${to.map((u) => u.name).join(" y ")}: ${ev.title} (${ev.date})`);
    return json({ ok: true, to: to.map((u) => u.name) });
  }
  if (p === "/api/tasks" && m === "POST") {
    const b = await body<{ title?: string; topic?: string; due_date?: string | null; assignee?: string }>();
    if (!b.title?.trim()) throw new HttpError(400, "Escribe la tarea");
    const t = b.topic ? await topicBySlug(env, b.topic, me) : null;
    const due = b.due_date && /^\d{4}-\d{2}-\d{2}$/.test(b.due_date) ? b.due_date : null;
    await env.DB.prepare(`INSERT INTO tasks (title, topic_id, assignee, due_date, created_by) VALUES (?, ?, ?, ?, ?)`)
      .bind(b.title.trim(), t?.id ?? null, b.assignee || me, due, me).run();
    return json({ ok: true });
  }
  // Ayuda de Claude para una tarea: pasos y acciones propuestas (se guardan en la tarea)
  if ((mm = p.match(/^\/api\/tasks\/(\d+)\/assist$/)) && m === "POST") {
    await guard(env, "tasks", mm[1], me);
    const task = await env.DB.prepare(`SELECT id, title, notes, due_date, assignee, topic_id FROM tasks WHERE id = ?`).bind(Number(mm[1]))
      .first<{ id: number; title: string; notes: string | null; due_date: string | null; assignee: string; topic_id: number | null }>();
    const t = task!.topic_id ? (await getTopics(env, me)).find((x) => x.id === task!.topic_id) ?? null : null;
    let context = "";
    if (t) {
      context = await topicContext(env, t);
      const { results: mails } = await env.DB.prepare(`SELECT from_name, subject, intent, todo, due FROM mails WHERE topic_id = ? AND state != 'archived' ORDER BY id DESC LIMIT 5`).bind(t.id).all<{ from_name: string; subject: string; intent: string; todo: string; due: string }>();
      const { results: evs } = await env.DB.prepare(`SELECT title, date, time FROM events WHERE topic_id = ? AND date >= date('now') ORDER BY date LIMIT 5`).bind(t.id).all<{ title: string; date: string; time: string }>();
      if (mails.length) context += "\nCorreos recientes:\n" + mails.map((x) => `- ${x.from_name}: ${x.subject}. ${x.intent} Qué hacer: ${x.todo}${x.due ? ` (plazo ${x.due})` : ""}`).join("\n");
      if (evs.length) context += "\nPróximos eventos:\n" + evs.map((x) => `- ${x.date} ${x.time || ""} ${x.title}`).join("\n");
    }
    const who = task!.assignee === "both" ? "los dos" : users(env).find((u) => u.email === task!.assignee)?.name || task!.assignee;
    const a = await assistTask(env, { task: task!.title, notes: task!.notes || "", due: task!.due_date, who, topic: t?.name ?? null, context, today: today() });
    const clean = {
      summary: String(a.summary || ""), steps: (a.steps || []).map(String).slice(0, 6),
      actions: (a.actions || []).filter((x) => x && x.type && x.label).slice(0, 4).map((x) => ({ ...x, done: false })),
      at: today(),
    };
    await env.DB.prepare(`UPDATE tasks SET ai = ? WHERE id = ?`).bind(JSON.stringify(clean), task!.id).run();
    return json(clean);
  }
  if ((mm = p.match(/^\/api\/tasks\/(\d+)\/ai-done$/)) && m === "POST") {
    await guard(env, "tasks", mm[1], me);
    const { index } = await body<{ index?: number }>();
    const r = await env.DB.prepare(`SELECT ai FROM tasks WHERE id = ?`).bind(Number(mm[1])).first<{ ai: string | null }>();
    if (r?.ai && typeof index === "number") {
      const a = JSON.parse(r.ai);
      if (a.actions?.[index]) a.actions[index].done = true;
      await env.DB.prepare(`UPDATE tasks SET ai = ? WHERE id = ?`).bind(JSON.stringify(a), Number(mm[1])).run();
    }
    return json({ ok: true });
  }
  // Comentarios de una tarea
  if ((mm = p.match(/^\/api\/tasks\/(\d+)\/comments$/)) && m === "POST") {
    await guard(env, "tasks", mm[1], me);
    const { text } = await body<{ text?: string }>();
    if (!text?.trim()) throw new HttpError(400, "El comentario está vacío");
    await env.DB.prepare(`INSERT INTO task_comments (task_id, author, text) VALUES (?, ?, ?)`).bind(Number(mm[1]), me, text.trim().slice(0, 2000)).run();
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/comments\/(\d+)$/)) && m === "DELETE") {
    const c = await env.DB.prepare(`SELECT author FROM task_comments WHERE id = ?`).bind(Number(mm[1])).first<{ author: string }>();
    if (!c) throw new HttpError(404, "Ese comentario ya no existe");
    if (c.author !== me) throw new HttpError(403, "Solo puedes borrar tus comentarios");
    await env.DB.prepare(`DELETE FROM task_comments WHERE id = ?`).bind(Number(mm[1])).run();
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/tasks\/(\d+)$/)) && m === "DELETE") {
    await guard(env, "tasks", mm[1], me);
    await env.DB.prepare(`DELETE FROM task_comments WHERE task_id = ?`).bind(Number(mm[1])).run();
    await env.DB.prepare(`DELETE FROM tasks WHERE id = ?`).bind(mm[1]).run();
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/expenses\/(\d+)$/)) && m === "DELETE") {
    const e = await env.DB.prepare(`SELECT name FROM expenses WHERE id = ?`).bind(mm[1]).first<{ name: string }>();
    await env.DB.prepare(`DELETE FROM expenses WHERE id = ?`).bind(mm[1]).run();
    const t = await topicBySlug(env, "finanzas", me).catch(() => null);
    if (t && e) await addHistory(env, t.id, `Suscripción quitada: ${e.name}`);
    return json({ ok: true });
  }

  if (p === "/api/trips/book" && m === "POST") {
    const b = await body<{ dest: string; d1: string; d2: string; who: string; count: number; handOnly?: boolean }>();
    const t = await topicBySlug(env, "viajes", me);
    const dep = new Date(b.d1 + "T12:00:00Z");
    const minus = (n: number) => { const d = new Date(dep); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
    const stmts = [
      env.DB.prepare(`INSERT INTO tasks (title, topic_id, assignee, due_date, created_by) VALUES (?, ?, ?, ?, ?)`).bind(`Check-in online vuelo a ${b.dest}`, t.id, me, minus(1), me),
      env.DB.prepare(`INSERT INTO tasks (title, topic_id, assignee, due_date, created_by) VALUES (?, ?, 'both', ?, ?)`).bind(`Hacer maletas para ${b.dest}`, t.id, minus(2), me),
      env.DB.prepare(`UPDATE topics SET status_summary = ? WHERE id = ?`).bind(`${b.dest}, ${b.d1} – ${b.d2}. Vuelo reservado para ${b.count}.`, t.id),
      env.DB.prepare(`INSERT INTO history (topic_id, at, text) VALUES (?, date('now'), ?)`).bind(t.id, `Reservado vuelo a ${b.dest} (${b.who})`),
    ];
    if (b.handOnly) stmts.push(env.DB.prepare(`INSERT INTO tasks (title, topic_id, assignee, due_date, created_by) VALUES (?, ?, ?, ?, ?)`).bind(`Añadir maleta facturada al vuelo de ${b.dest}`, t.id, me, addDays(7), me));
    await env.DB.batch(stmts);
    return json({ ok: true, checkin: minus(1), pack: minus(2) });
  }

  // Documentos compartidos: archivos de hasta 10 MB, guardados en trozos dentro de D1
  if (p === "/api/files" && m === "POST") {
    const name = (url.searchParams.get("name") || "archivo").slice(0, 200);
    const type = req.headers.get("content-type") || "application/octet-stream";
    const buf = new Uint8Array(await req.arrayBuffer());
    if (!buf.length) throw new HttpError(400, "El archivo está vacío");
    if (buf.length > MAX_FILE) throw new HttpError(413, `«${name}» pesa ${(buf.length / 1048576).toFixed(1)} MB; el máximo es 10 MB`);
    const n = Math.ceil(buf.length / CHUNK);
    const row = await env.DB.prepare(`INSERT INTO files (name, type, size, chunks, uploaded_by) VALUES (?, ?, ?, ?, ?) RETURNING id`)
      .bind(name, type, buf.length, n, me).first<{ id: number }>();
    const stmts = [];
    for (let i = 0; i < n; i++) stmts.push(env.DB.prepare(`INSERT INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?)`).bind(row!.id, i, buf.slice(i * CHUNK, (i + 1) * CHUNK).buffer));
    try { await env.DB.batch(stmts); }
    catch (e) { await env.DB.prepare(`DELETE FROM files WHERE id = ?`).bind(row!.id).run(); throw e; }
    return json({ ok: true, id: row!.id });
  }
  if ((mm = p.match(/^\/api\/files\/(\d+)$/)) && m === "GET") {
    const f = await env.DB.prepare(`SELECT id, name, type, size FROM files WHERE id = ?`).bind(mm[1]).first<{ id: number; name: string; type: string; size: number }>();
    if (!f) throw new HttpError(404, "Ese archivo ya no existe");
    const { results } = await env.DB.prepare(`SELECT data FROM file_chunks WHERE file_id = ? ORDER BY idx`).bind(f.id).all<{ data: ArrayBuffer | number[] }>();
    const out = new Uint8Array(f.size); let off = 0;
    for (const r of results) { const c = new Uint8Array(r.data as ArrayBuffer); out.set(c, off); off += c.length; }
    const inline = /^(image\/|application\/pdf|text\/plain)/.test(f.type);
    return new Response(out, { headers: {
      "content-type": f.type || "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "cache-control": "private, max-age=3600",
    } });
  }
  if ((mm = p.match(/^\/api\/files\/(\d+)$/)) && m === "DELETE") {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM file_chunks WHERE file_id = ?`).bind(mm[1]),
      env.DB.prepare(`DELETE FROM files WHERE id = ?`).bind(mm[1]),
    ]);
    return json({ ok: true });
  }

  // Borra los datos de ejemplo. Solo por petición explícita (no hay botón en la web).
  if (p === "/api/admin/reset-demo" && m === "POST") {
    const { confirm } = await body<{ confirm?: string }>();
    if (confirm !== "BORRAR EJEMPLOS") throw new HttpError(400, 'Envía {"confirm":"BORRAR EJEMPLOS"}');
    await resetDemo(env);
    return json({ ok: true });
  }

  throw new HttpError(404, "No encontrado");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      // Calendario suscribible (protegido por un token largo en la dirección)
      const cal = url.pathname.match(/^\/cal\/([a-f0-9]{32})\.ics$/);
      if (cal) {
        await ensureSchema(env);
        const tok = await env.DB.prepare(`SELECT v FROM settings WHERE k = 'cal_token'`).first<{ v: string }>();
        if (!tok || tok.v !== cal[1]) return new Response("No encontrado", { status: 404 });
        const { results } = await env.DB.prepare(`SELECT e.id, e.title, e.date, e.time, e.place, e.note, e.who, e.attendee, t.name AS topic FROM events e LEFT JOIN topics t ON t.id = e.topic_id WHERE e.in_calendar = 1 AND t.private_to IS NULL ORDER BY e.date`).all();
        return new Response(buildIcs(results as never, users(env)), { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store" } });
      }

      if (url.pathname.startsWith("/api/")) {
        const me = await getUser(req, env);
        if (!me) return json({ error: "No autorizado" }, 401);
        await ensureSchema(env);
        return await handleApi(req, env, me);
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      // Solo los usuarios autorizados llegan a la API, así que les mostramos el motivo real.
      return json({ error: explainError(e) }, 500);
    }
  },

  /** Emails a todo@ (tareas) e inbox@ (correos reenviados) */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const parsed = await PostalMime.parse(message.raw);
    const sender = (parsed.from?.address || message.from).toLowerCase();
    if (!allowedSenders(env).includes(sender)) {
      message.setReject("Remitente no autorizado");
      return;
    }
    await ensureSchema(env);
    const text = parsed.text || parsed.html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") || "";
    const to = message.to.toLowerCase();
    // Respuestas Sí / No a las invitaciones (llegan a calendario@)
    if (to.startsWith("calendario@")) {
      const cal = (parsed.attachments || []).map((a) => typeof a.content === "string" ? a.content : new TextDecoder().decode(a.content as ArrayBuffer)).find((c) => c.includes("BEGIN:VCALENDAR"))
        || (text.includes("BEGIN:VCALENDAR") ? text : "");
      const unfolded = cal.replace(/\r?\n[ \t]/g, "");
      const id = unfolded.match(/UID:event-(\d+)@/)?.[1];
      const st = unfolded.match(/ATTENDEE[^\n]*PARTSTAT=([A-Z-]+)[^\n]*mailto:([^\s\r\n]+)/i);
      if (id && st) {
        const ev = await env.DB.prepare(`SELECT rsvp FROM events WHERE id = ?`).bind(Number(id)).first<{ rsvp: string | null }>();
        if (ev) {
          const r = ev.rsvp ? JSON.parse(ev.rsvp) : {};
          r[st[2].toLowerCase()] = st[1].toUpperCase();
          await env.DB.prepare(`UPDATE events SET rsvp = ? WHERE id = ?`).bind(JSON.stringify(r), Number(id)).run();
        }
      }
      return;
    }
    if (to.startsWith("inbox@")) await ingestMail(env, { subject: parsed.subject || "", text, forwardedBy: sender });
    else await ingest(env, { text, sender, source: "email", subject: parsed.subject });
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await ensureSchema(env);
  },
} satisfies ExportedHandler<Env>;
