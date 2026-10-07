/**
 * Interfaz propia del proveedor LLM (PRD 6.1). El ciclo del agente solo conoce estos tipos;
 * cambiar de proveedor es cambiar la implementación, no el ciclo.
 */
export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
  /** Datos opacos del proveedor que deben devolverse tal cual en el siguiente turno (p. ej. la firma de razonamiento de Gemini). */
  extra?: Record<string, unknown>;
};

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type LlmTool = { name: string; description: string; parameters: Record<string, unknown> };

export type Uso = { entrada: number; salida: number };

export type LlmResponse = { message: Extract<ChatMessage, { role: "assistant" }>; uso: Uso };

export interface LlmAdapter {
  readonly provider: string;
  readonly model: string;
  enviar(mensajes: ChatMessage[], herramientas: LlmTool[]): Promise<LlmResponse>;
}

const REINTENTABLES = new Set([429, 500, 502, 503, 504]);

/**
 * Error del proveedor. `transitorio` = saturación, límite de tasa, timeout o red:
 * vale la pena intentar con otro modelo. Un 401/400 no lo es (otro modelo fallaría igual).
 */
export class ErrorProveedor extends Error {
  constructor(
    message: string,
    readonly transitorio: boolean,
  ) {
    super(message);
  }
}
const ESPERAS_MS = [2_000, 5_000];

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * fetch con timeout, reintentos y mensaje de error legible (CA5).
 * Si el proveedor está saturado (503) o limita la tasa (429), reintenta hasta 2 veces
 * esperando 2 y 5 s (o lo que indique el encabezado Retry-After). Si aun así falla,
 * LlmConRespaldo pasa al siguiente modelo.
 */
export async function fetchConTimeout(url: string, init: RequestInit, timeoutMs: number, proveedor: string): Promise<Response> {
  for (let intento = 0; ; intento++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.ok) return res;
      if (REINTENTABLES.has(res.status) && intento < ESPERAS_MS.length) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const espera = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : ESPERAS_MS[intento];
        console.warn(`${proveedor} respondió ${res.status}; reintento ${intento + 1}/${ESPERAS_MS.length} en ${espera / 1000} s`);
        await dormir(espera);
        continue;
      }
      const cuerpo = (await res.text()).slice(0, 300);
      const pista =
        res.status === 401 || res.status === 403
          ? " (revisa la clave del proveedor)"
          : res.status === 429
            ? " (límite de uso del proveedor; espera un minuto)"
            : res.status === 503
              ? " (el modelo está saturado; prueba otro modelo o reintenta en un momento)"
              : "";
      throw new ErrorProveedor(`${proveedor} respondió ${res.status}${pista}: ${cuerpo}`, REINTENTABLES.has(res.status));
    } catch (e) {
      if (e instanceof ErrorProveedor) throw e;
      if (e instanceof Error && e.name === "AbortError") throw new ErrorProveedor(`${proveedor} no respondió en ${Math.round(timeoutMs / 1000)} s`, true);
      throw new ErrorProveedor(`no hubo conexión con ${proveedor}: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      clearTimeout(timer);
    }
  }
}
