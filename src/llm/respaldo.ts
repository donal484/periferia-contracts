import { ErrorProveedor, type ChatMessage, type LlmAdapter, type LlmResponse, type LlmTool } from "./adapter";

/** Tras pasarse a un respaldo, se queda en él este tiempo antes de volver a intentar el principal. */
const MINUTOS_EN_RESPALDO = 5;

/**
 * Envuelve varios adaptadores en orden de preferencia. Si el actual falla por una causa transitoria
 * (saturado, límite de tasa, timeout) después de sus reintentos, pasa al siguiente.
 * El ciclo del agente no se entera: sigue viendo un solo LlmAdapter.
 */
export class LlmConRespaldo implements LlmAdapter {
  private activo = 0;
  private desde = 0;

  constructor(private readonly cadena: LlmAdapter[]) {
    if (cadena.length === 0) throw new Error("se necesita al menos un modelo");
  }

  get provider(): string {
    return this.cadena[this.activo].provider;
  }

  get model(): string {
    return this.cadena[this.activo].model;
  }

  /** Modelos configurados, en orden, para mostrarlos en /api/health. */
  get modelos(): string[] {
    return this.cadena.map((a) => `${a.provider}/${a.model}`);
  }

  async enviar(mensajes: ChatMessage[], herramientas: LlmTool[]): Promise<LlmResponse> {
    if (this.activo > 0 && Date.now() - this.desde > MINUTOS_EN_RESPALDO * 60_000) this.activo = 0;
    const errores: string[] = [];
    for (let i = this.activo; i < this.cadena.length; i++) {
      const llm = this.cadena[i];
      try {
        const r = await llm.enviar(mensajes, herramientas);
        if (i !== this.activo) {
          console.warn(`Usando modelo de respaldo ${llm.provider}/${llm.model}`);
          this.activo = i;
          this.desde = Date.now();
        }
        return r;
      } catch (e) {
        if (!(e instanceof ErrorProveedor) || !e.transitorio) throw e;
        errores.push(`${llm.provider}/${llm.model}: ${e.message}`);
        if (i + 1 < this.cadena.length) console.warn(`${llm.provider}/${llm.model} no disponible; probando ${this.cadena[i + 1].provider}/${this.cadena[i + 1].model}`);
      }
    }
    throw new ErrorProveedor(`ningún modelo respondió. ${errores.join(" | ")}`, true);
  }
}
