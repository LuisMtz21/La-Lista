import {
  getQueuedOperations,
  readSnapshot,
  reconcileSnapshot,
  removeQueuedOperation
} from './offline.js';

export function createSynchronization(client, onSnapshot, onStatus) {
  let channel = null;
  let spaceId = null;
  let generation = 0;
  let refreshTimer = null;
  let refreshingGeneration = null;
  let refreshAgainGeneration = null;

  function setStatus(state, message) {
    onStatus(state, message);
  }

  async function fetchServerSnapshot(targetSpaceId) {
    const { data: lists, error: listsError } = await client
      .from('listas')
      .select('id, espacio_id, titulo, fecha_creacion, fecha_modificacion, archivada')
      .eq('espacio_id', targetSpaceId)
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

    return { espacioId: targetSpaceId, listas: lists, elementos: items };
  }

  async function refresh(expectedGeneration = generation) {
    if (expectedGeneration !== generation) return;
    if (refreshingGeneration === expectedGeneration) {
      refreshAgainGeneration = expectedGeneration;
      return;
    }
    const targetSpaceId = spaceId;
    refreshingGeneration = expectedGeneration;
    try {
      const serverSnapshot = await fetchServerSnapshot(targetSpaceId);
      if (expectedGeneration !== generation || targetSpaceId !== spaceId) return;
      const snapshot = await reconcileSnapshot(
        serverSnapshot,
        () => expectedGeneration === generation && targetSpaceId === spaceId
      );
      if (expectedGeneration !== generation || targetSpaceId !== spaceId) return;
      onSnapshot(snapshot);
      setStatus(navigator.onLine ? 'synced' : 'offline', navigator.onLine ? 'Sincronizado' : 'Sin conexión');
    } finally {
      if (refreshingGeneration === expectedGeneration) refreshingGeneration = null;
      if (refreshAgainGeneration === expectedGeneration) {
        refreshAgainGeneration = null;
        if (expectedGeneration === generation) void refresh(expectedGeneration).catch((error) => {
          console.error('La actualización de listas falló:', error);
          if (expectedGeneration === generation) setStatus('error', 'Error de sincronización');
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

  async function flush(expectedGeneration = generation) {
    if (expectedGeneration !== generation) return;
    const targetSpaceId = spaceId;
    if (!navigator.onLine || !targetSpaceId) {
      setStatus('offline', 'Sin conexión');
      return;
    }
    const operations = await getQueuedOperations(targetSpaceId);
    if (expectedGeneration !== generation || targetSpaceId !== spaceId) return;
    if (!operations.length) return;
    setStatus('syncing', 'Sincronizando');
    try {
      for (const operation of operations) {
        if (expectedGeneration !== generation || targetSpaceId !== spaceId) return;
        await sendOperation(operation);
        await removeQueuedOperation(operation.id);
      }
      if (expectedGeneration === generation) setStatus('synced', 'Sincronizado');
    } catch (error) {
      if (expectedGeneration === generation) setStatus('error', 'Error de sincronización');
      throw error;
    }
  }

  async function synchronize(expectedGeneration = generation) {
    if (expectedGeneration !== generation) return;
    if (!navigator.onLine) {
      setStatus('offline', 'Sin conexión');
      return;
    }
    setStatus('syncing', 'Sincronizando');
    try {
      await flush(expectedGeneration);
      if (expectedGeneration === generation) await refresh(expectedGeneration);
    } catch (error) {
      if (expectedGeneration !== generation) throw error;
      console.error('La sincronización falló:', error);
      setStatus('error', 'Error de sincronización');
      throw error;
    }
  }

  function scheduleRefresh(expectedGeneration = generation) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!navigator.onLine || expectedGeneration !== generation) return;
      void refresh(expectedGeneration).catch((error) => {
        console.error('La actualización en tiempo real falló:', error);
        if (expectedGeneration === generation) setStatus('error', 'Error de sincronización');
      });
    }, 140);
  }

  async function start(id) {
    stop();
    spaceId = id;
    const expectedGeneration = generation;
    const cached = await readSnapshot(id);
    if (expectedGeneration !== generation) return;
    if (cached.espacioId === id) onSnapshot(cached);

    if (navigator.onLine) {
      try {
        await synchronize(expectedGeneration);
      } catch {
        // Keep the cached view available while the connection recovers.
      }
      if (expectedGeneration !== generation) return;
      channel = client.channel(`listas-${id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'listas', filter: `espacio_id=eq.${id}` }, () => scheduleRefresh(expectedGeneration))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'elementos' }, () => scheduleRefresh(expectedGeneration))
        .subscribe((status) => {
          if (expectedGeneration !== generation) return;
          if (status === 'SUBSCRIBED') {
            setStatus('synced', 'Sincronizado');
            scheduleRefresh(expectedGeneration);
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
    await synchronize(generation);
  }

  function stop() {
    generation += 1;
    if (refreshTimer) clearTimeout(refreshTimer);
    if (channel) void client.removeChannel(channel);
    channel = null;
    spaceId = null;
    refreshingGeneration = null;
    refreshAgainGeneration = null;
  }

  return { start, reconnect, stop, refresh, flush };
}
