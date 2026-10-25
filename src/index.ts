import PostalMime from "postal-mime";
import { allowedSenders, getUser } from "./auth";
import { analyzeMail, classify, draftEmail, reviseEmail } from "./claude";
import { ensureSchema, resetDemo } from "./db";
import { buildIcs } from "./ics";
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

async function getTopics(env: Env): Promise<Topic[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, slug, name, status_summary, next_step, email_lang, email_to, email_ref, owner, sort FROM topics ORDER BY sort, id`,
  ).all<Topic>();
  return results;
}
async function topicBySlug(env: Env, slug: string): Promise<Topic> {
  const t = (await getTopics(env)).find((x) => x.slug === slug);
  if (!t) throw new HttpError(404, "Ese tema no existe");
  return t;
}
const addHistory = (env: Env, topicId: number, text: string, source = "web") =>
  env.DB.prepare(`INSERT INTO history (topic_id, at, text, source) VALUES (?, date('now'), ?, ?)`).bind(topicId, text, source).run();

/** Todo lo que necesita la web, en una sola llamada. */
async function state(env: Env, me: string) {
  const [topics, items, history, tasks, mails, events, expenses, cal] = await Promise.all([
    getTopics(env),
    env.DB.prepare(`SELECT id, topic_id, kind, label, value, extra FROM topic_items ORDER BY sort, id`).all(),
    env.DB.prepare(`SELECT id, topic_id, at, text, source FROM history ORDER BY at DESC, id DESC`).all(),
    env.DB.prepare(`SELECT id, title, notes, topic_id, assignee, due_date, status, source, created_at, completed_at, completed_by FROM tasks ORDER BY id`).all(),
    env.DB.prepare(`SELECT id, topic_id, from_name, from_addr, subject, lang, received_at, intent, todo, due, state, forwarded_by FROM mails WHERE state != 'archived' ORDER BY received_at DESC, id DESC`).all(),
    env.DB.prepare(`SELECT id, topic_id, mail_id, title, date, time, who, place, note, attendee, in_calendar FROM events ORDER BY date, id`).all(),
    env.DB.prepare(`SELECT id, name, cat, amount, cycle, next, notice, sub, flag FROM expenses ORDER BY id`).all(),
    env.DB.prepare(`SELECT v FROM settings WHERE k = 'cal_token'`).first<{ v: string }>(),
  ]);
  return {
    me, today: today(), users: users(env), topics,
    items: items.results, history: history.results, tasks: tasks.results,
    mails: mails.results, events: events.results, expenses: expenses.results,
    calPath: cal ? `/cal/${cal.v}.ics` : null,
  };
}

/** Entrada libre (web o todo@): Claude la convierte en tarea o nota. */
async function ingest(env: Env, opts: { text: string; sender: string; source: "web" | "email"; subject?: string }) {
  const topics = await getTopics(env);
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
  if (r.kind === "task") {
    await env.DB.prepare(`INSERT INTO tasks (title, notes, topic_id, assignee, due_date, source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(r.title, r.notes ?? null, topic?.id ?? null, r.assignee || opts.sender, r.due_date || null, opts.source, opts.sender).run();
  } else if (topic) {
    await addHistory(env, topic.id, r.title, opts.source);
  }
  return { ...r, topic_name: topic?.name ?? "Sin tema" };
}

/** Correo reenviado a inbox@: resumen, tema, plazo y eventos. */
async function ingestMail(env: Env, opts: { subject: string; text: string; forwardedBy: string }) {
  const topics = await getTopics(env);
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
    const { status } = await body<{ status?: string }>();
    if (status === "done") await env.DB.prepare(`UPDATE tasks SET status='done', completed_at=date('now'), completed_by=? WHERE id=?`).bind(me, mm[1]).run();
    else await env.DB.prepare(`UPDATE tasks SET status='open', completed_at=NULL, completed_by=NULL WHERE id=?`).bind(mm[1]).run();
    return json({ ok: true });
  }

  if ((mm = p.match(/^\/api\/topics\/([\w-]+)\/note$/)) && m === "POST") {
    const { text } = await body<{ text?: string }>();
    if (!text?.trim()) throw new HttpError(400, "La nota está vacía");
    const t = await topicBySlug(env, mm[1]);
    await addHistory(env, t.id, text.trim());
    await env.DB.prepare(`UPDATE topics SET status_summary = ?, updated_at = datetime('now') WHERE id = ?`).bind(text.trim().replace(/\.?$/, "."), t.id).run();
    return json({ ok: true });
  }

  if ((mm = p.match(/^\/api\/mails\/(\d+)$/)) && m === "POST") {
    const { action } = await body<{ action?: string }>();
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
    const t = await topicBySlug(env, topic);
    let replyTo: { from: string; subject: string; intent: string; todo: string; addr: string } | undefined;
    if (mailId) {
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
    const t = await topicBySlug(env, topic);
    await addHistory(env, t.id, `Email enviado${to ? ` a ${to}` : ""}: «${subject}»`);
    await env.DB.prepare(`INSERT INTO tasks (title, topic_id, assignee, due_date, created_by) VALUES (?, ?, ?, ?, ?)`)
      .bind(`Revisar si han respondido: ${subject}`, t.id, me, addDays(14), me).run();
    if (mailId) await env.DB.prepare(`UPDATE mails SET state = 'done' WHERE id = ?`).bind(mailId).run();
    return json({ ok: true });
  }

  if (p === "/api/expenses" && m === "POST") {
    const e = await body<{ name?: string; amount?: number; cycle?: string; next?: string; notice?: string }>();
    if (!e.name?.trim() || !(Number(e.amount) > 0)) throw new HttpError(400, "Escribe el nombre y un importe mayor que 0");
    const cycle = ["mes", "trimestre", "año"].includes(e.cycle || "") ? e.cycle : "mes";
    await env.DB.prepare(`INSERT INTO expenses (name, cat, amount, cycle, next, notice, sub) VALUES (?, 'Ocio y suscripciones', ?, ?, ?, ?, 1)`)
      .bind(e.name.trim(), Number(e.amount), cycle, e.next || null, e.notice?.trim() || "En cualquier momento").run();
    const t = await topicBySlug(env, "finanzas").catch(() => null);
    if (t) await addHistory(env, t.id, `Suscripción añadida: ${e.name.trim()}`);
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/expenses\/(\d+)$/)) && m === "DELETE") {
    const e = await env.DB.prepare(`SELECT name FROM expenses WHERE id = ?`).bind(mm[1]).first<{ name: string }>();
    await env.DB.prepare(`DELETE FROM expenses WHERE id = ?`).bind(mm[1]).run();
    const t = await topicBySlug(env, "finanzas").catch(() => null);
    if (t && e) await addHistory(env, t.id, `Suscripción quitada: ${e.name}`);
    return json({ ok: true });
  }

  if (p === "/api/trips/book" && m === "POST") {
    const b = await body<{ dest: string; d1: string; d2: string; who: string; count: number; handOnly?: boolean }>();
    const t = await topicBySlug(env, "viajes");
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
        const { results } = await env.DB.prepare(`SELECT e.id, e.title, e.date, e.time, e.place, e.note, e.who, e.attendee, t.name AS topic FROM events e LEFT JOIN topics t ON t.id = e.topic_id WHERE e.in_calendar = 1 ORDER BY e.date`).all();
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
    if (to.startsWith("inbox@")) await ingestMail(env, { subject: parsed.subject || "", text, forwardedBy: sender });
    else await ingest(env, { text, sender, source: "email", subject: parsed.subject });
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await ensureSchema(env);
  },
} satisfies ExportedHandler<Env>;
