export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
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
}

export interface User { email: string; name: string; fullName: string }

/** Lo que Claude devuelve al clasificar una entrada */
export interface Classification {
  kind: "task" | "note";
  title: string;
  notes?: string;
  topic_slug: string;
  assignee: string; // email o "both"
  due_date?: string; // YYYY-MM-DD
  topic_status_update?: string;
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

export interface Draft { to: string; subject: string; body: string; lang: string }
