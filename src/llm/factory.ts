import type { LlmAdapter } from "./adapter";
import { AnthropicAdapter } from "./anthropic";
import { OpenAiAdapter } from "./openai";
import { LlmConRespaldo } from "./respaldo";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

type Env = Record<string, string | undefined>;

function lista(valor: string | undefined): string[] {
  return (valor ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Un adaptador por cada modelo configurado de cada proveedor que tenga clave. */
function porProveedor(env: Env, timeoutMs: number): Record<string, LlmAdapter[]> {
  const out: Record<string, LlmAdapter[]> = { gemini: [], anthropic: [], openai: [] };
  if (env.GEMINI_API_KEY) {
    const modelos = [env.GEMINI_MODEL ?? "gemini-2.5-flash", ...lista(env.GEMINI_FALLBACK_MODELS)];
    out.gemini = modelos.map((model) => new OpenAiAdapter({ apiKey: env.GEMINI_API_KEY ?? "", model, timeoutMs, baseUrl: GEMINI_BASE_URL, proveedor: "gemini" }));
  }
  if (env.ANTHROPIC_API_KEY) {
    out.anthropic = [new AnthropicAdapter({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001", timeoutMs, maxTokens: 4096 })];
  }
  if (env.OPENAI_API_KEY) {
    // OPENAI_BASE_URL permite usar cualquier API compatible con OpenAI (Groq, OpenRouter, Ollama…).
    out.openai = [new OpenAiAdapter({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL ?? "gpt-4o-mini", timeoutMs, baseUrl: env.OPENAI_BASE_URL })];
  }
  return out;
}

/**
 * Arma la cadena de modelos: primero el proveedor de LLM_PROVIDER (su modelo principal y sus respaldos),
 * luego los demás proveedores que tengan clave. Devuelve null si no hay ninguna clave.
 */
export function crearLlm(env: Env = process.env): LlmConRespaldo | null {
  const timeoutMs = Number(env.LLM_TIMEOUT_MS ?? 60_000);
  const disponibles = porProveedor(env, timeoutMs);
  const preferido = env.LLM_PROVIDER ?? ["gemini", "anthropic", "openai"].find((p) => disponibles[p].length > 0) ?? "openai";
  const orden = [preferido, ...["gemini", "anthropic", "openai"].filter((p) => p !== preferido)];
  const cadena = orden.flatMap((p) => disponibles[p] ?? []);
  return cadena.length ? new LlmConRespaldo(cadena) : null;
}
