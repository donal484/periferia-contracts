import { fetchConTimeout, type ChatMessage, type LlmAdapter, type LlmResponse, type LlmTool } from "./adapter";

type Bloque =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

type MensajeAnthropic = { role: "user" | "assistant"; content: Bloque[] };

type AnthropicRespuesta = { content: Bloque[]; usage?: { input_tokens: number; output_tokens: number } };

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic";
  constructor(
    private readonly opts: { apiKey: string; model: string; timeoutMs: number; maxTokens: number },
  ) {}

  get model(): string {
    return this.opts.model;
  }

  async enviar(mensajes: ChatMessage[], herramientas: LlmTool[]): Promise<LlmResponse> {
    const system = mensajes.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const res = await fetchConTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: { "x-api-key": this.opts.apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.opts.model,
          max_tokens: this.opts.maxTokens,
          system,
          messages: convertir(mensajes),
          ...(herramientas.length ? { tools: herramientas.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
        }),
      },
      this.opts.timeoutMs,
      "Anthropic",
    );
    const data = (await res.json()) as AnthropicRespuesta;
    const texto = data.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    const llamadas = data.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }] : []));
    return {
      message: { role: "assistant", content: texto, tool_calls: llamadas.length ? llamadas : undefined },
      uso: { entrada: data.usage?.input_tokens ?? 0, salida: data.usage?.output_tokens ?? 0 },
    };
  }
}

/** Anthropic exige turnos alternados: los resultados de herramientas viajan como bloques del usuario y se fusionan turnos consecutivos. */
function convertir(mensajes: ChatMessage[]): MensajeAnthropic[] {
  const out: MensajeAnthropic[] = [];
  const empujar = (role: "user" | "assistant", bloques: Bloque[]): void => {
    if (bloques.length === 0) return;
    const ultimo = out[out.length - 1];
    if (ultimo && ultimo.role === role) ultimo.content.push(...bloques);
    else out.push({ role, content: bloques });
  };
  for (const m of mensajes) {
    if (m.role === "system") continue;
    if (m.role === "user") empujar("user", [{ type: "text", text: m.content }]);
    else if (m.role === "tool") empujar("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }]);
    else if (m.role === "assistant") {
      const bloques: Bloque[] = m.content ? [{ type: "text", text: m.content }] : [];
      for (const tc of m.tool_calls ?? []) bloques.push({ type: "tool_use", id: tc.id, name: tc.name, input: JSON.parse(tc.arguments || "{}") as unknown });
      empujar("assistant", bloques);
    }
  }
  return out;
}
