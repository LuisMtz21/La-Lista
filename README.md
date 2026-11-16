# La Lista

PWA estática en HTML, CSS y JavaScript, con Bootstrap 5, Supabase PostgreSQL, Auth anónimo, RLS y Realtime. Cloudflare Pages solo sirve los archivos estáticos; no hay servidor propio.

## Configurar Supabase

1. Crea un proyecto en Supabase y habilita **Anonymous Sign-Ins** en **Authentication → Sign In / Providers**. No hace falta crear cuentas con formularios.
2. Ejecuta las dos migraciones SQL en orden desde **SQL Editor** (`20261115000000_la_lista.sql` y después `20261115225000_permitir_varios_espacios.sql`), o despliega ambas con Supabase CLI:

   ```powershell
   supabase login
   supabase link --project-ref TU_PROJECT_REF
   supabase db push
   ```

   Si ya tenías una versión anterior, `supabase db push` aplica la migración nueva pendiente sin volver a crear el esquema inicial.

3. Despliega las Edge Functions desde la raíz del proyecto:

   ```powershell
   supabase functions deploy crear-espacio
   supabase functions deploy crear-invitacion
   supabase functions deploy canjear-invitacion
   ```

   Supabase proporciona `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` al entorno de Edge Functions. La clave `service_role` solo se utiliza en el servidor y nunca debe copiarse a archivos públicos.
4. En **Project Settings → API**, copia el Project URL y la clave pública `anon`/publishable en `js/config.js`:

   ```js
   export const SUPABASE_CONFIG = {
     url: 'https://TU_PROJECT_REF.supabase.co',
     anonKey: 'TU_CLAVE_PUBLICA_ANON'
   };
   ```

   No publiques una clave `service_role`. Las tablas privadas no son accesibles sin un dispositivo vinculado; las políticas RLS aplican a listas, elementos y dispositivos.
5. Sirve localmente por HTTP en `localhost` o HTTPS. Los módulos ES, IndexedDB y el Service Worker no funcionarán correctamente al abrir `index.html` directamente como archivo.

## Publicar en Cloudflare Pages

1. Sube el proyecto a un repositorio GitHub, incluyendo `js/config.js` con únicamente la URL y la clave pública de Supabase.
2. En Cloudflare, crea un proyecto **Workers & Pages → Pages → Connect to Git** y selecciona el repositorio.
3. Usa la raíz del proyecto como directorio y deja vacíos el comando de compilación y el directorio de salida. No se requiere PHP, Node.js ni un servidor permanente.
4. Publica el sitio por HTTPS. Configura también en Supabase **Authentication → URL Configuration → Site URL** con la URL de Pages y agrega los dominios de producción y previsualización necesarios a **Redirect URLs**.

## Uso y seguridad del espacio

- En el primer dispositivo, selecciona **Crear un espacio nuevo**. Después usa **Compartir** para generar una invitación de un solo uso, válida por 24 horas.
- Abre el enlace de invitación en el otro dispositivo para vincularlo. Desde **Compartir y dispositivos** puedes revisar los dispositivos y revocar el acceso de otro dispositivo.
- El botón **Espacios** permite crear otro espacio, cambiar entre los espacios vinculados, entrar con otra invitación o salir de un espacio. Salir revoca únicamente el dispositivo actual en ese espacio y borra su caché local; para volver a entrar hace falta una invitación nueva.
- El token sin procesar de la invitación solo se muestra al crear el enlace; en PostgreSQL se almacena su hash. Trata el enlace como un secreto hasta que se canjee. Cada invitación es de un solo uso: si borras los datos del navegador o ya usaste el código, pide un enlace nuevo desde un dispositivo que conserve acceso.
- Cada operación se guarda primero en IndexedDB y se envía en orden cuando vuelve la conexión. PostgreSQL sigue siendo el almacenamiento principal; IndexedDB es solo caché y cola temporal. Realtime actualiza las vistas abiertas.
- La app usa CDN para Bootstrap y Supabase JS. Tras la primera carga con conexión, el Service Worker conserva los recursos estáticos y CDN visitados para el uso offline.

## Estructura

- `index.html`, `css/styles.css`, `js/`: aplicación estática.
- `manifest.json`, `service-worker.js`, `assets/icons/`: instalación y caché PWA.
- `supabase/migrations/`: esquema, índices, políticas RLS y publicación Realtime.
- `supabase/functions/`: creación de espacios e invitaciones y vinculación segura de dispositivos.
