import {
  getQueuedOperations,
  readSnapshot,
  reconcileSnapshot,
  removeQueuedOperation,
  writeSnapshot
} from './offline.js';

export function createSynchronization(client, onSnapshot, onStatus) {
  let channel = null;
  let spaceId = null;
  let refreshTimer = null;
  let refreshing = false;
  let refreshAgain = false;

  function setStatus(state, message) {
    onStatus(state, message);
  }

  async function fetchServerSnapshot() {
    const { data: lists, error: listsError } = await client
      .from('listas')
      .select('id, espacio_id, titulo, fecha_creacion, fecha_modificacion, archivada')
      .eq('espacio_id', spaceId)
      .order('fecha_creacion', { ascending: false });
    if (listsError) throw listsError;

    let items = [];
    if (lists.length) {
      const { data, error } = await client
        .from('elementos')
        .select('id, lista_id, texto, completado, orden, fecha_creacion, fecha_modificacion')
        .in('lista_id', lists.map((list) => list.id));
      if (error) throw error;
      items = data;
    }

    return { espacioId: spaceId, listas: lists, elementos: items };
  }

  async function refresh() {
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      const serverSnapshot = await fetchServerSnapshot();
      const snapshot = await reconcileSnapshot(serverSnapshot);
      onSnapshot(snapshot);
      setStatus(navigator.onLine ? 'synced' : 'offline', navigator.onLine ? 'Sincronizado' : 'Sin conexión');
    } finally {
      refreshing = false;
      if (refreshAgain) {
        refreshAgain = false;
        void refresh().catch((error) => {
          console.error('La actualización de listas falló:', error);
          setStatus('error', 'Error de sincronización');
        });
      }
    }
  }

  async function sendOperation(operation) {
    let result;
    if (operation.type === 'list_upsert') {
      result = await client.from('listas').upsert(operation.payload, { onConflict: 'id' });
    } else if (operation.type === 'list_delete') {
      result = await client.from('listas').delete().eq('id', operation.payload.id);
    } else if (operation.type === 'item_upsert') {
      result = await client.from('elementos').upsert(operation.payload, { onConflict: 'id' });
    } else if (operation.type === 'item_delete') {
      result = await client.from('elementos').delete().eq('id', operation.payload.id);
    } else {
      throw new Error(`Operación pendiente desconocida: ${operation.type}`);
    }
    if (result.error) throw result.error;
  }

  async function flush() {
    if (!navigator.onLine || !spaceId) {
      setStatus('offline', 'Sin conexión');
      return;
    }
    const operations = await getQueuedOperations(spaceId);
    if (!operations.length) return;
    setStatus('syncing', 'Sincronizando');
    try {
      for (const operation of operations) {
        await sendOperation(operation);
        await removeQueuedOperation(operation.id);
      }
      setStatus('synced', 'Sincronizado');
    } catch (error) {
      setStatus('error', 'Error de sincronización');
      throw error;
    }
  }

  async function synchronize() {
    if (!navigator.onLine) {
      setStatus('offline', 'Sin conexión');
      return;
    }
    setStatus('syncing', 'Sincronizando');
    try {
      await flush();
      await refresh();
    } catch (error) {
      console.error('La sincronización falló:', error);
      setStatus('error', 'Error de sincronización');
      throw error;
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!navigator.onLine) return;
      void refresh().catch((error) => {
        console.error('La actualización en tiempo real falló:', error);
        setStatus('error', 'Error de sincronización');
      });
    }, 140);
  }

  async function start(id) {
    spaceId = id;
    const cached = await readSnapshot();
    if (cached.espacioId === id) onSnapshot(cached);

    if (navigator.onLine) {
      try {
        await synchronize();
      } catch {
        // Keep the cached view available while the connection recovers.
      }
      channel = client.channel(`listas-${id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'listas', filter: `espacio_id=eq.${id}` }, scheduleRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'elementos' }, scheduleRefresh)
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            setStatus('synced', 'Sincronizado');
            scheduleRefresh();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            setStatus('error', 'Error de sincronización');
          }
        });
    } else {
      setStatus('offline', 'Sin conexión');
    }
  }

  async function reconnect() {
    if (!spaceId) return;
    await synchronize();
  }

  function stop() {
    if (refreshTimer) clearTimeout(refreshTimer);
    if (channel) void client.removeChannel(channel);
    channel = null;
    spaceId = null;
  }

  return { start, reconnect, stop, refresh, flush };
}
