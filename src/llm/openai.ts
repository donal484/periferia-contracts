import { fetchConTimeout, type ChatMessage, type LlmAdapter, type LlmResponse, type LlmTool } from "./adapter";

type OpenAiRespuesta = {
  choices: {
    message: {
      content: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string }; extra_content?: Record<string, unknown> }[];
    };
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
};

type Esquema = { [k: string]: unknown };

/**
 * Sirve para OpenAI y para cualquier API compatible con su formato (Gemini, Groq, OpenRouter…):
 * solo cambian la URL base y la clave.
 */
export class OpenAiAdapter implements LlmAdapter {
  constructor(
    private readonly opts: { apiKey: string; model: string; timeoutMs: number; baseUrl?: string; proveedor?: string },
  ) {}

  get provider(): string {
    return this.opts.proveedor ?? "openai";
  }

  get model(): string {
    return this.opts.model;
  }

  private get baseUrl(): string {
    return (this.opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  }

  async enviar(mensajes: ChatMessage[], herramientas: LlmTool[]): Promise<LlmResponse> {
    const compatible = !this.baseUrl.includes("api.openai.com");
    const res = await fetchConTimeout(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.opts.model,
          messages: mensajes.map((m) => mapear(m, this.provider === "gemini")),
          ...(herramientas.length
            ? {
                tools: herramientas.map((t) => ({
                  type: "function",
                  function: { name: t.name, description: t.description, parameters: compatible ? simplificar(t.parameters) : t.parameters },
                })),
              }
            : {}),
        }),
      },
      this.opts.timeoutMs,
      this.provider,
    );
    const data = (await res.json()) as OpenAiRespuesta;
    const msg = data.choices[0]?.message;
    if (!msg) throw new Error(`${this.provider} devolvió una respuesta vacía`);
    return {
      message: {
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: msg.tool_calls?.map((tc, i) => ({
          id: tc.id || `llamada-${Date.now()}-${i}`,
          name: tc.function.name,
          arguments: tc.function.arguments,
          ...(tc.extra_content ? { extra: tc.extra_content } : {}),
        })),
      },
      uso: { entrada: data.usage?.prompt_tokens ?? 0, salida: data.usage?.completion_tokens ?? 0 },
    };
  }
}

/**
 * Proveedores compatibles (como Gemini) aceptan un subconjunto más estricto de JSON Schema:
 * no admiten `type: ["string", "null"]` ni `additionalProperties`. Se traduce a `nullable: true`.
 */
function simplificar(esquema: Esquema): Esquema {
  const out: Esquema = {};
  for (const [k, v] of Object.entries(esquema)) {
    if (k === "additionalProperties") continue;
    if (k === "type" && Array.isArray(v)) {
      out.type = v.find((t) => t !== "null") ?? "string";
      if (v.includes("null")) out.nullable = true;
    } else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, Esquema>).map(([p, s]) => [p, simplificar(s)]));
    } else out[k] = v;
  }
  return out;
}

/**
 * Gemini 3 exige que cada llamada a herramienta del historial lleve la "thought_signature" que devolvió.
 * Se reenvía tal cual; si falta (historial antiguo u otro modelo), se usa el valor que Google documenta
 * para omitir la validación.
 */
const FIRMA_OMITIDA = { google: { thought_signature: "skip_thought_signature_validator" } };

function mapear(m: ChatMessage, esGemini: boolean): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content || null,
      ...(m.tool_calls?.length
        ? {
            tool_calls: m.tool_calls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
              ...(tc.extra ? { extra_content: tc.extra } : esGemini ? { extra_content: FIRMA_OMITIDA } : {}),
            })),
          }
        : {}),
    };
  }
  return { role: m.role, content: m.content };
}
