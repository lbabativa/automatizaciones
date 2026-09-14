import mongoose, { Schema, type InferSchemaType } from 'mongoose';

export const ESTADOS_AVISO = ['pendiente', 'enviando', 'entregado', 'fallido'] as const;

const IntentoAvisoSchema = new Schema(
  {
    fecha: { type: Date, required: true },
    codigo: { type: Number },
    error: { type: String },
    /** Quién lo envió: nube (API en Vercel), api-local o pc (worker). */
    desde: { type: String },
  },
  { _id: false },
);

/**
 * Aviso firmado al servicio de un cliente (bandeja de salida). Lo crean el cierre de consultas
 * y de lotes; lo envía `despacharAvisos`, con reintentos. Se borra solo a los 60 días.
 */
const AvisoSchema = new Schema(
  {
    clienteSlug: { type: String, required: true, index: true },
    /** lote.terminado, lote.cancelado, consulta.completada, consulta.fallida o prueba. */
    evento: { type: String, required: true },
    url: { type: String, required: true },
    cuerpo: { type: Schema.Types.Mixed, required: true },
    estado: { type: String, enum: ESTADOS_AVISO, default: 'pendiente' },
    intentos: { type: Number, default: 0 },
    maxIntentos: { type: Number, default: 5 },
    proximoIntento: { type: Date, default: Date.now },
    /** Mientras se envía, nadie más lo toma hasta esta hora. */
    bloqueadoHasta: { type: Date },
    ultimoCodigo: { type: Number },
    ultimoError: { type: String },
    entregadoEn: { type: Date },
    loteId: { type: Schema.Types.ObjectId, index: true },
    trabajoId: { type: Schema.Types.ObjectId },
    historial: { type: [IntentoAvisoSchema], default: [] },
  },
  { timestamps: true, collection: 'avisos' },
);

AvisoSchema.index({ estado: 1, proximoIntento: 1 });
AvisoSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 60 });

export type AvisoDoc = InferSchemaType<typeof AvisoSchema> & { _id: mongoose.Types.ObjectId; createdAt: Date; updatedAt: Date };

export const Aviso = mongoose.models.Aviso ?? mongoose.model('Aviso', AvisoSchema);
