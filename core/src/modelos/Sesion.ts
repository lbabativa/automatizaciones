import mongoose, { Schema } from 'mongoose';

/**
 * Estado de sesión de Playwright (cookies + storage) por cliente y portal, cifrado.
 * Permite que el robot no vuelva a iniciar sesión en cada consulta y que una
 * persona abra la sesión manualmente cuando el portal tenga captcha.
 */
const SesionSchema = new Schema(
  {
    clienteSlug: { type: String, required: true },
    portal: { type: String, required: true },
    storageStateCifrado: { type: String, required: true },
    origen: { type: String, enum: ['manual', 'automatica'], default: 'automatica' },
    valida: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'sesiones' },
);

SesionSchema.index({ clienteSlug: 1, portal: 1 }, { unique: true });

export const Sesion = mongoose.models.Sesion ?? mongoose.model('Sesion', SesionSchema);
