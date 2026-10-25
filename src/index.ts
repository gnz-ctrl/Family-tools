import PostalMime from "postal-mime";
import { allowedSenders, getUser } from "./auth";
import { classify, draftGermanEmail } from "./claude";
import type { Env, Topic } from "./types";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const today = () => new Date().toISOString().slice(0, 10);

async function getTopics(env: Env): Promise<Topic[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, slug, name, icon, status_summary FROM topics ORDER BY id",
  ).all<Topic>();
  return results;
}

/** Clasifica con Claude y guarda. Común a la web y al email. */
async function ingest(env: Env, opts: { text: string; sender: string; source: "web" | "email"; subject?: string }) {
  const topics = await getTopics(env);
  const result = await classify(env, {
    text: opts.subject ? `Asunto: ${opts.subject}\n\n${opts.text}` : opts.text,
    sender: opts.sender,
    topics,
    users: allowedSenders(env),
    today: today(),
  });

  await env.DB.prepare(
    "INSERT INTO inbox_items (source, sender, subject, body, ai_result) VALUES (?, ?, ?, ?, ?)",
  ).bind(opts.source, opts.sender, opts.subject ?? null, opts.text, JSON.stringify(result)).run();

  const topic = topics.find((t) => t.slug === result.topic_slug) ?? topics.find((t) => t.slug === "otros");

  if (result.topic_status_update && topic) {
    await env.DB.prepare(
      "UPDATE topics SET status_summary = ?, updated_at = datetime('now') WHERE id = ?",
    ).bind(result.topic_status_update, topic.id).run();
  }

  let taskId: number | null = null;
  if (result.kind === "task") {
    const r = await env.DB.prepare(
      `INSERT INTO tasks (title, notes, topic_id, assignee, due_date, source, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(
      result.title, result.notes ?? null, topic?.id ?? null, result.assignee || "both",
      result.due_date ?? null, opts.source, opts.sender,
    ).first<{ id: number }>();
    taskId = r?.id ?? null;
  }
  return { ...result, task_id: taskId };
}

async function handleApi(req: Request, env: Env, user: string): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/api/me") return json({ email: user });

  if (path === "/api/topics" && req.method === "GET") return json(await getTopics(env));

  if (path === "/api/tasks" && req.method === "GET") {
    const status = url.searchParams.get("status") === "done" ? "done" : "open";
    const order = status === "open"
      ? "ORDER BY t.due_date IS NULL, t.due_date, t.created_at DESC"
      : "ORDER BY t.completed_at DESC LIMIT 100";
    const { results } = await env.DB.prepare(
      `SELECT t.*, tp.name AS topic_name, tp.icon AS topic_icon
       FROM tasks t LEFT JOIN topics tp ON tp.id = t.topic_id
       WHERE t.status = ? ${order}`,
    ).bind(status).all();
    return json(results);
  }

  // Entrada libre: Claude decide dónde va
  if (path === "/api/inbox" && req.method === "POST") {
    const { text } = (await req.json()) as { text?: string };
    if (!text?.trim()) return json({ error: "Texto vacío" }, 400);
    return json(await ingest(env, { text, sender: user, source: "web" }));
  }

  const m = path.match(/^\/api\/tasks\/(\d+)$/);
  if (m && req.method === "PATCH") {
    const body = (await req.json()) as { status?: "open" | "done"; title?: string; due_date?: string | null };
    if (body.status === "done") {
      await env.DB.prepare(
        "UPDATE tasks SET status='done', completed_at=datetime('now'), completed_by=? WHERE id=?",
      ).bind(user, m[1]).run();
    } else if (body.status === "open") {
      await env.DB.prepare(
        "UPDATE tasks SET status='open', completed_at=NULL, completed_by=NULL WHERE id=?",
      ).bind(m[1]).run();
    }
    if (body.title !== undefined || body.due_date !== undefined) {
      await env.DB.prepare(
        "UPDATE tasks SET title=COALESCE(?, title), due_date=? WHERE id=?",
      ).bind(body.title ?? null, body.due_date ?? null, m[1]).run();
    }
    return json({ ok: true });
  }

  if (path === "/api/draft-email" && req.method === "POST") {
    const { request, topic_slug } = (await req.json()) as { request?: string; topic_slug?: string };
    if (!request?.trim()) return json({ error: "Describe qué necesitas" }, 400);
    const topic = (await getTopics(env)).find((t) => t.slug === topic_slug);
    return json({ draft: await draftGermanEmail(env, { request, topic, senderName: user }) });
  }

  return json({ error: "No encontrado" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      const user = await getUser(req, env);
      if (!user) return json({ error: "No autorizado" }, 401);
      try {
        return await handleApi(req, env, user);
      } catch (e) {
        console.error(e);
        return json({ error: "Error interno" }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },

  /** Emails a todo@ / inbox@ (Cloudflare Email Routing → este Worker) */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const parsed = await PostalMime.parse(message.raw);
    const sender = (parsed.from?.address || message.from).toLowerCase();

    if (!allowedSenders(env).includes(sender)) {
      message.setReject("Remitente no autorizado");
      return;
    }
    const text = parsed.text || parsed.html?.replace(/<[^>]+>/g, " ") || "";
    await ingest(env, { text, sender, source: "email", subject: parsed.subject });
  },

  /** Cron: resumen semanal (fase 2) */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status='open'").first<{ n: number }>();
    console.log(`Resumen semanal: ${open?.n ?? 0} tareas abiertas`);
  },
} satisfies ExportedHandler<Env>;
