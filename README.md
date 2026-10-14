# Reto 02 · Agente "Registro de Contratos Vigentes"

Agente conversacional que procesa el buzón único de contratos de Periferia: clasifica cada correo, registra lo limpio en el maestro, pide confirmación para lo dudoso, redacta el acuse para el comercial y genera alertas de vencimiento y pólizas. Además responde preguntas sobre el maestro y lleva el ciclo de vida de las pólizas.

## Qué puede hacer la analista en el chat

| Ejemplo | Herramientas |
|---|---|
| "Procesa el buzón con fecha de hoy 2026-09-03" | `leer_buzon`, `validar`, `registrar`, `alertas` |
| "Confirmo el valor 0 y la fecha fin 2027-08-31" | `registrar` con `confirmado: true` |
| "¿Qué contratos vencen antes de fin de año?" / "¿Qué tenemos con Industrias Delta?" | `consultar` |
| "La póliza de CT-2026-015 ya la expidió Seguros X, número 123" | `actualizar_poliza` (pide confirmación) |
| Botón "Ver reporte" | Alertas, maestro y acuses a comerciales, sin usar el modelo |

**Link de prueba:** https://periferia-contracts.onrender.com
**Clave de acceso:** `a6e0abe7153e1789c12f49364e37336e` (la interfaz la pide al enviar el primer mensaje)

> El servicio usa el plan gratuito de Render: si estuvo inactivo, la primera carga tarda cerca de un minuto en despertar.

## Requisitos
- [Bun](https://bun.sh) 1.1 o superior.
- Una clave de Gemini (gratis en Google AI Studio), OpenAI o Anthropic. Solo para el chat; la demo no la necesita.

## Correr en local (un comando)

```bash
cp .env.example .env      # pon tu clave en OPENAI_API_KEY o ANTHROPIC_API_KEY
bun install
bun run dev               # http://localhost:3000
```

## Demo sin modelo

```bash
bun install && bun run demo.ts
```

Limpia `out/`, procesa los 6 mensajes llamando directamente a las herramientas, hace la segunda pasada confirmando `msg-006`, muestra dos casos de error controlado e imprime `out/alertas.md`.

## Variables de entorno

| Variable | Uso |
|---|---|
| `LLM_PROVIDER` | `gemini`, `openai` o `anthropic`. Si se omite, usa el que tenga clave. |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Clave de Google AI Studio (tiene capa gratuita) y modelo (por defecto `gemini-2.5-flash`). |
| `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_BASE_URL` | OpenAI, o cualquier API compatible cambiando la URL base. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Clave y modelo de Anthropic. |
| `LLM_TIMEOUT_MS` | Tiempo máximo de espera al proveedor. |
| `MAX_AGENT_ITERATIONS` | Tope de pasos herramienta → modelo por turno (CA1). |
| `MAX_SESSION_TOKENS` | Tope de tokens por sesión, para que nadie gaste la clave sin límite. |
| `ACCESS_KEY` | Opcional. Protege la API del link público. |

Las claves solo se leen en el backend. No aparecen en el front, en el repositorio, en los logs ni en las respuestas de la API.

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, pending, usage }` |
| `GET` | `/api/sessions/:id` | Historial de la sesión (vista del chat, mensajes y pendientes) |
| `GET` | `/api/health` | `{ ok, provider, model }` sin claves |
| `GET` | `/api/reporte?hoy=YYYY-MM-DD` | Alertas, maestro y acuses para la vista "Ver reporte"; con `hoy` regenera las alertas sin usar el modelo |
| `POST` | `/api/reset` | Borra `out/` y las sesiones para repetir la demo |

## Estructura

```
agent/prompt.md                  comportamiento (system prompt)
src/knowledge/registro-contratos.md  conocimiento del proceso
src/tools/contratos.ts           7 herramientas (zod), importables sin el servidor
src/lib/                         extracción, reglas de negocio, acuses, archivos
src/agent/cycle.ts               ciclo del agente, topes y confirmación humana
src/llm/                         interfaz del proveedor + OpenAI + Anthropic
src/server.ts                    API HTTP y archivos estáticos
web/                             front de chat (HTML + JS sin framework)
modulo/                          bonus: agente empaquetado (bun run build:modulo)
demo.ts                          verificación sin modelo
```


