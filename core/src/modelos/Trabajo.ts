import mongoose, { Schema, type InferSchemaType } from 'mongoose';

export const ESTADOS_TRABAJO = ['programado', 'pendiente', 'en_proceso', 'completado', 'fallido'] as const;
export type EstadoTrabajo = (typeof ESTADOS_TRABAJO)[number];

const ErrorSchema = new Schema(
  {
    codigo: { type: String, required: true },
    mensaje: { type: String, required: true },
  },
  { _id: false },
);

const AnotacionSchema = new Schema({ t: { type: Date, default: Date.now }, mensaje: { type: String, required: true } }, { _id: false });

/** Marca un trabajo de prueba lanzado desde el editor de flujos. */
const PruebaSchema = new Schema(
  {
    origen: { type: String, enum: ['borrador', 'publicado'], default: 'borrador' },
    capturarCadaPaso: { type: Boolean, default: true },
  },
  { _id: false },
);

const TrabajoSchema = new Schema(
  {
    clienteSlug: { type: String, required: true, index: true },
    modulo: { type: String, required: true, index: true },
    portal: { type: String, required: true },
    parametros: { type: Schema.Types.Mixed, required: true },
    huella: { type: String, required: true, index: true },
    estado: { type: String, enum: ESTADOS_TRABAJO, default: 'pendiente', index: true },
    prioridad: { type: Number, default: 0 },
    intentos: { type: Number, default: 0 },
    maxIntentos: { type: Number, default: 2 },
    modo: { type: String, enum: ['sync', 'async'], default: 'async' },
    callbackUrl: { type: String },
    resultado: { type: Schema.Types.Mixed },
    error: { type: ErrorSchema },
    capturas: { type: [String], default: [] },
    /** Registro paso a paso que escribe el worker mientras ejecuta (visible en la consola). */
    bitacora: { type: [AnotacionSchema], default: [] },
    prueba: { type: PruebaSchema },
    /** Lote al que pertenece, si llegó en un lote. */
    loteId: { type: Schema.Types.ObjectId, index: true },
    /** Consultas programadas: pasan a pendiente cuando llega esta hora. */
    disponibleDesde: { type: Date },
    workerId: { type: String },
    iniciadoEn: { type: Date },
    terminadoEn: { type: Date },
    duracionMs: { type: Number },
  },
  { timestamps: true, collection: 'trabajos' },
);

TrabajoSchema.index({ estado: 1, prioridad: -1, createdAt: 1 });
TrabajoSchema.index({ huella: 1, estado: 1, terminadoEn: -1 });
TrabajoSchema.index({ estado: 1, disponibleDesde: 1 });

export type ErrorTrabajo = InferSchemaType<typeof ErrorSchema>;
export type TrabajoDoc = InferSchemaType<typeof TrabajoSchema> & { _id: mongoose.Types.ObjectId; createdAt: Date; updatedAt: Date };

export const Trabajo = mongoose.models.Trabajo ?? mongoose.model('Trabajo', TrabajoSchema);
