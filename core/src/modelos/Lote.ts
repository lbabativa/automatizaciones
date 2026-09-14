import mongoose, { Schema, type InferSchemaType } from 'mongoose';

export const ESTADOS_LOTE = ['programado', 'en_cola', 'procesando', 'terminado', 'cancelado'] as const;

/** Una fila del lote. Las filas repetidas, o consultadas hace poco, apuntan a un mismo trabajo. */
const ItemLoteSchema = new Schema(
  {
    parametros: { type: Schema.Types.Mixed, required: true },
    huella: { type: String, required: true },
    trabajoId: { type: Schema.Types.ObjectId, required: true },
    /** El resultado viene de una consulta reciente con los mismos parámetros. */
    desdeCache: { type: Boolean, default: false },
  },
  { _id: false },
);

/**
 * Lote de consultas de un cliente para una automatización. Llega por API o como Excel/CSV
 * desde la consola; cada fila única es un trabajo de la cola con `loteId`.
 */
const LoteSchema = new Schema(
  {
    clienteSlug: { type: String, required: true, index: true },
    modulo: { type: String, required: true },
    portal: { type: String, required: true },
    nombre: { type: String },
    origen: { type: String, enum: ['api', 'consola'], default: 'api' },
    archivo: { type: String },
    estado: { type: String, enum: ESTADOS_LOTE, default: 'en_cola', index: true },
    programadoPara: { type: Date },
    total: { type: Number, required: true },
    /** Filas por estado de su trabajo, más las que vienen del caché. Se recalcula al cerrar cada trabajo. */
    contadores: { type: Schema.Types.Mixed, default: {} },
    items: { type: [ItemLoteSchema], default: [] },
    terminadoEn: { type: Date },
    canceladoEn: { type: Date },
    /** Enlace de seguimiento: { token, venceEn, enmascarar }. */
    progreso: { type: Schema.Types.Mixed },
    /** Aviso al servicio del cliente: { url, eventos }. */
    aviso: { type: Schema.Types.Mixed },
  },
  { timestamps: true, collection: 'lotes' },
);

LoteSchema.index({ 'progreso.token': 1 }, { sparse: true });

export type LoteDoc = InferSchemaType<typeof LoteSchema> & { _id: mongoose.Types.ObjectId; createdAt: Date; updatedAt: Date };

export const Lote = mongoose.models.Lote ?? mongoose.model('Lote', LoteSchema);
