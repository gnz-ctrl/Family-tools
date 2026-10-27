export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Envío de emails (invitaciones de calendario). Solo a direcciones verificadas en Email Routing. */
  EMAIL?: { send(message: Record<string, unknown>): Promise<{ messageId: string }> };
  /** Dirección desde la que salen las invitaciones */
  MAIL_FROM?: string;
  ANTHROPIC_API_KEY: string;
  CLAUDE_MODEL: string;
  /** Emails de los usuarios, separados por coma (mismo orden que USER_NAMES) */
  ALLOWED_SENDERS: string;
  /** Nombres cortos, p.ej. "Gonzalo,Sabrina" */
  USER_NAMES: string;
  /** Nombres completos para firmar emails */
  USER_FULLNAMES: string;
  ACCESS_TEAM: string;
  ACCESS_AUD: string;
  /** Solo en local (.dev.vars). Nunca en producción. */
  DEV_MODE?: string;
  DEV_USER?: string;
  /** Solo en local: respuestas simuladas de Claude para probar sin gastar */
  MOCK_CLAUDE?: string;
}

export interface Topic {
  id: number;
  slug: string;
  name: string;
  status_summary: string | null;
  next_step: string | null;
  email_lang: string | null;
  email_to: string | null;
  email_ref: string | null;
  owner: string | null;
  sort: number;
  /** Email de la única persona que lo ve; null = compartido */
  private_to: string | null;
  /** Color de la tarjeta elegido por el usuario actual */
  color?: string | null;
  /** Paneles que el usuario actual ha quitado (JSON) */
  hidden?: string | null;
}

export interface User { email: string; name: string; fullName: string }

/** Lo que Claude devuelve al clasificar una entrada */
export interface Classification {
  kind: "task" | "note" | "event";
  title: string;
  notes?: string;
  topic_slug: string;
  assignee: string; // email o "both"
  due_date?: string; // YYYY-MM-DD
  topic_status_update?: string;
  /** Solo para kind="event" */
  event_time?: string;
  place?: string;
}

/** Lo que Claude devuelve al analizar un correo reenviado a inbox@ */
export interface MailAnalysis {
  topic_slug: string;
  from_name: string;
  from_addr?: string;
  subject: string;
  lang: string; // "Alemán", "Español"...
  intent: string; // qué quieren, en español
  todo: string; // qué hay que hacer, en español
  due?: string | null; // YYYY-MM-DD
  events?: Array<{ title: string; date: string; time?: string; who?: string; place?: string; note?: string }>;
}

/** Ayuda de Claude para una tarea */
export interface TaskAction {
  type: "draft_email" | "create_task" | "create_event" | "add_fact" | "set_due" | "set_next_step";
  label: string;
  request?: string; lang?: string;          // draft_email
  title?: string; date?: string; time?: string; place?: string; // create_task / create_event / set_due
  key?: string; value?: string; text?: string;                  // add_fact / set_next_step
  done?: boolean;
}
export interface TaskAssist { summary: string; steps: string[]; actions: TaskAction[]; at?: string }

export interface Draft { to: string; subject: string; body: string; lang: string }
