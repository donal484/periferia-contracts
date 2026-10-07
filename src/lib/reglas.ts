/**
 * Parámetros de negocio del proceso. Cambiar una regla no debe tocar el servidor ni el ciclo del agente.
 */
export const REGLAS = {
  /** NIT de Periferia (el CONTRATISTA). Nunca es el cliente. */
  nitPropio: "900123456",
  /** Fecha en que se congeló el maestro. */
  fechaCorte: "2026-05-30",
  /** Por debajo de este umbral un campo va a revisión humana (RN5). */
  umbralConfianza: 0.8,
  /** Ventana de alerta de vencimiento en días (HU-5). */
  diasAlertaVencimiento: 60,
  /** Similitud mínima de objeto para considerar el mismo contrato (RN2). */
  similitudObjeto: 0.9,
  monedas: ["COP", "USD", "PEN", "PAB", "HNL"] as const,
  paises: ["CO", "EC", "PE", "PA", "HN"] as const,
  /** Moneda por defecto cuando el contrato no fija valor (contrato marco por demanda). */
  monedaPorPais: { CO: "COP", EC: "USD", PE: "PEN", PA: "USD", HN: "HNL" } as const,
} as const;

export type Moneda = (typeof REGLAS.monedas)[number];
export type Pais = (typeof REGLAS.paises)[number];
