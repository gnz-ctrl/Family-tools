# Family Hub — Arquitectura

Plataforma privada para organizar los temas personales y familiares de dos usuarios
(+ invitados temporales). Dominio: `sbkperez.me`. Repo: `gnz-ctrl/tools`.

Principio rector: **sencillo de usar y de mantener**. Todo en Cloudflare, sin servidores propios.

## Decisiones

| Pieza | Elección | Motivo |
|---|---|---|
| Web/app | PWA (HTML + JS sin framework) servida por el Worker | Instalable en móvil, sin build complejo |
| Backend | Un único Cloudflare Worker (TypeScript) | Sin servidor que mantener |
| Base de datos | Cloudflare D1 (SQLite) | Simple, backups exportables |
| Ficheros | Cloudflare R2 (fase 2) | Cartas, pólizas, PDFs |
| Login | Cloudflare Access (Zero Trust) delante de `sbkperez.me` | Login con código por email o Google, sin gestionar contraseñas |
| Entrada por email | Cloudflare Email Routing → Email Worker | `todo@sbkperez.me`, `inbox@sbkperez.me` |
| IA | API de Claude (Anthropic) | Clasificar, resumir, redactar en alemán |
| Tareas programadas | Cron Triggers del Worker | Resumen semanal, avisos de plazos |

### Regla de seguridad para la IA
Claude **propone y redacta**; nunca envía emails, borra datos ni paga nada sin confirmación humana.

## Flujo de entrada

```
email a todo@ / inbox@ ──┐
web (formulario rápido) ─┼─► Worker ─► Claude (clasifica) ─► D1
atajo móvil / Telegram ──┘                               (tarea | nota | plazo | documento)
```

Solo se aceptan emails de remitentes en la lista `ALLOWED_SENDERS`.

## Modelo de datos (MVP)

- **users**: email, nombre, rol (`owner` | `guest`)
- **topics** (temas): Salud, Pensión, Casa, Coche, Finanzas/Steuer, Niños, Viajes… con `status_summary` (estado actual) que Claude mantiene
- **tasks**: título, notas, tema, asignado a (yo / pareja / ambos), fecha límite, estado, recurrencia, origen (web/email), fecha de completado
- **inbox_items**: todo lo que entra en bruto (para auditoría y reprocesado)
- **guest_links** (fase 4): token, caduca_en, permisos (p.ej. `shopping`, `schedule`)

## Fases

1. **MVP** — login (Access), tareas, temas, entrada por email, clasificación con Claude.
2. Documentos en R2, foto de carta → resumen + plazo, emails en alemán, resumen semanal.
3. Calendario (feed ICS + Google Calendar), reenvíos desde Gmail, contratos y Kündigungsfristen.
4. Viajes: tiempo (Open-Meteo), lista de maleta por persona, búsqueda de vuelos (enlaces); invitados temporales.

## Gmail
Primero: filtros de Gmail en cada cuenta que **reenvían** lo relevante a `inbox@sbkperez.me`.
La API de Gmail se deja para más tarde (en modo "testing" de Google los permisos caducan cada 7 días).

## Coste estimado
Cloudflare: gratis o ~5 $/mes (Workers Paid). API de Claude: pocos euros/mes con dos usuarios.

## Backups
Fase 2: cron semanal exporta D1 a R2.
