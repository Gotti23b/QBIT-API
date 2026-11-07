# QBIT API

Backend central de QBIT Web, Windows y Android. La implementación activa usa **Supabase Edge Functions + PostgreSQL + Auth + Row Level Security**. No necesita un servidor Node.js propio ni una base SQLite.

## Proyecto desplegado

- Supabase project ref: `jtxyzfjgspnmzlvztjqx`
- Edge Function: `qbit-api`
- Endpoint: `https://jtxyzfjgspnmzlvztjqx.supabase.co/functions/v1/qbit-api`
- JWT verification: habilitada.
- Código de la función: `supabase/functions/qbit-api/index.ts`

## Recursos de base de datos

- `public.qbit_devices`: dispositivos vinculados a cada cuenta.
- `public.qbit_device_commands`: cola de acciones y resultados.
- RLS habilitado en ambas tablas. Las políticas limitan el acceso a los datos del usuario autenticado.
- Las acciones permitidas están limitadas a una lista explícita; los clientes deben pedir confirmación local antes de ejecutarlas.

## Rutas

Todas requieren una sesión válida de Supabase en el encabezado `Authorization: Bearer <access_token>`.

| Método | Ruta | Función |
|---|---|---|
| GET | `/devices` | Listar dispositivos propios |
| POST | `/devices` | Registrar un dispositivo |
| PATCH | `/devices/:id` | Actualizar presencia |
| POST | `/devices/:id/commands` | Enviar una acción permitida |
| GET | `/devices/:id/commands` | Consultar acciones pendientes |
| POST | `/commands/:id/claim` | Reclamar una acción |
| PATCH | `/commands/:id/result` | Guardar el resultado |

## Desarrollo y despliegue

La función se ejecuta en el entorno administrado de Supabase (Deno). No ejecutar `npm start` ni desplegar un servidor Node para esta arquitectura.

Para modificar la función:
1. Editar `supabase/functions/qbit-api/index.ts`.
2. Desplegarla como Edge Function `qbit-api` en el proyecto indicado.
3. Mantener `verify_jwt = true`.
4. Verificar las políticas RLS antes de habilitar nuevas acciones.

**Nunca** incluir claves `service_role` en clientes web, Android o Windows. Las aplicaciones usan la clave publishable y la sesión del usuario.

## Dominio propio

El endpoint actual usa el dominio oficial `supabase.co`. Configurar `api.qbit.uno` como dominio personalizado requiere habilitar el complemento pago de Custom Domains de Supabase y agregar los registros DNS de verificación que Supabase genere. No se activa automáticamente ni forma parte de esta configuración gratuita.


## Controles remotos de Android

QBIT Android puede recibir acciones de navegación del sistema (Atrás, Inicio, notificaciones, ajustes rápidos y bloqueo), volumen y brillo. La navegación requiere que el usuario habilite manualmente el servicio **QBIT Control** en Ajustes → Accesibilidad. El brillo requiere conceder a QBIT el permiso especial para modificar ajustes del sistema. Cada orden se confirma en el propio teléfono.

El cliente Android debe permanecer abierto para consultar la cola de órdenes; no se promete control en segundo plano cuando Android suspende la aplicación. El servicio de accesibilidad no captura ni transmite el contenido de pantalla.
