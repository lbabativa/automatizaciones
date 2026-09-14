import mongoose, { Schema, type InferSchemaType } from 'mongoose';

const ModuloClienteSchema = new Schema(
  {
    nombre: { type: String, required: true },
    activo: { type: Boolean, default: true },
    config: { type: Schema.Types.Mixed, default: {} },
    /** Entrega de resultados propia de esta automatización; si falta, se usa la general del cliente. */
    entrega: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const ClienteSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    nombre: { type: String, required: true },
    nit: { type: String },
    activo: { type: Boolean, default: true },
    apiKeyHash: { type: String, index: true },
    apiKeyPrefijo: { type: String },
    limitePorMinuto: { type: Number, default: 30 },
    modulos: { type: [ModuloClienteSchema], default: [] },
    /** { portal: { campo: valorCifrado } } */
    credenciales: { type: Schema.Types.Mixed, default: {} },
    /** Dominios desde los que un navegador puede llamar a la API con la clave de este cliente (CORS). */
    origenesPermitidos: { type: [String], default: [] },
    /** Aceptar llamadas sin encabezado Origin (desde servidores). */
    permitirSinOrigen: { type: Boolean, default: true },
    /** Entrega de resultados: enlace de seguimiento de los lotes y aviso al servicio del cliente. */
    entrega: { type: Schema.Types.Mixed },
    /** Clave con la que se firman los avisos (HMAC). No se lista con el cliente. */
    avisoSecreto: { type: String, select: false },
  },
  { timestamps: true, collection: 'clientes' },
);

export type ModuloCliente = InferSchemaType<typeof ModuloClienteSchema>;
export type ClienteDoc = InferSchemaType<typeof ClienteSchema> & { _id: mongoose.Types.ObjectId };

export const Cliente = mongoose.models.Cliente ?? mongoose.model('Cliente', ClienteSchema);
