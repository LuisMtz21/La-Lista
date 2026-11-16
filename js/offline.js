const DATABASE_NAME = 'la-lista-local';
const DATABASE_VERSION = 2;
const ACTIVE_SNAPSHOT_KEY = 'shared-space';
const SPACE_SNAPSHOT_PREFIX = 'space:';

function snapshotKey(spaceId) {
  return spaceId ? `${SPACE_SNAPSHOT_PREFIX}${spaceId}` : ACTIVE_SNAPSHOT_KEY;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('snapshot')) {
        database.createObjectStore('snapshot', { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains('operations')) {
        database.createObjectStore('operations', { keyPath: 'id', autoIncrement: true });
      }
      if (!database.objectStoreNames.contains('spaces')) {
        database.createObjectStore('spaces', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('No se pudo abrir la caché local.'));
  });
}

async function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('No se pudo leer la caché local.'));
  });
}

function applyOperation(snapshot, operation) {
  const next = {
    listas: [...(snapshot?.listas || [])],
    elementos: [...(snapshot?.elementos || [])],
    espacioId: operation.payload?.espacio_id || snapshot?.espacioId || null
  };
  const { type, payload } = operation;

  if (type === 'list_upsert') {
    const index = next.listas.findIndex((list) => list.id === payload.id);
    if (index < 0) next.listas.push(payload);
    else next.listas[index] = payload;
  } else if (type === 'list_delete') {
    next.listas = next.listas.filter((list) => list.id !== payload.id);
    next.elementos = next.elementos.filter((item) => item.lista_id !== payload.id);
  } else if (type === 'item_upsert') {
    const index = next.elementos.findIndex((item) => item.id === payload.id);
    if (index < 0) next.elementos.push(payload);
    else next.elementos[index] = payload;
  } else if (type === 'item_delete') {
    next.elementos = next.elementos.filter((item) => item.id !== payload.id);
  }

  return next;
}

export async function readSnapshot(spaceId) {
  const database = await openDatabase();
  const store = database.transaction('snapshot').objectStore('snapshot');
  const requested = store.get(snapshotKey(spaceId));
  const activeRequest = spaceId ? store.get(ACTIVE_SNAPSHOT_KEY) : null;
  const [entry, active] = await Promise.all([
    requestResult(requested),
    activeRequest ? requestResult(activeRequest) : Promise.resolve(null)
  ]);
  database.close();
  if (entry?.value) return entry.value;
  if (active?.value && active.value.espacioId === spaceId) return active.value;
  return { espacioId: spaceId || null, listas: [], elementos: [] };
}

export async function writeSnapshot(snapshot, shouldSetActive = () => true) {
  const database = await openDatabase();
  const transaction = database.transaction('snapshot', 'readwrite');
  const store = transaction.objectStore('snapshot');
  if (shouldSetActive()) store.put({ key: ACTIVE_SNAPSHOT_KEY, value: snapshot });
  if (snapshot.espacioId) {
    store.put({ key: snapshotKey(snapshot.espacioId), value: snapshot });
  }
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('No se pudo guardar la caché local.'));
    transaction.onabort = () => reject(transaction.error || new Error('Se canceló el guardado local.'));
  });
  database.close();
}

export async function readSpaces() {
  const database = await openDatabase();
  const spaces = await requestResult(database.transaction('spaces').objectStore('spaces').getAll());
  database.close();
  return spaces;
}

export async function writeSpaces(spaces) {
  const database = await openDatabase();
  const transaction = database.transaction('spaces', 'readwrite');
  const store = transaction.objectStore('spaces');
  store.clear();
  for (const space of spaces) store.put(space);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('No se pudieron guardar los espacios.'));
    transaction.onabort = () => reject(transaction.error || new Error('Se canceló el guardado de espacios.'));
  });
  database.close();
}

export async function removeSpaceData(spaceId) {
  const database = await openDatabase();
  const transaction = database.transaction(['snapshot', 'operations', 'spaces'], 'readwrite');
  const snapshots = transaction.objectStore('snapshot');
  snapshots.delete(snapshotKey(spaceId));
  const activeRequest = snapshots.get(ACTIVE_SNAPSHOT_KEY);
  activeRequest.onsuccess = () => {
    if (activeRequest.result?.value?.espacioId === spaceId) snapshots.delete(ACTIVE_SNAPSHOT_KEY);
  };
  const operationsStore = transaction.objectStore('operations');
  const operationsRequest = operationsStore.getAll();
  operationsRequest.onsuccess = () => {
    for (const operation of operationsRequest.result) {
      if (operation.espacio_id === spaceId) operationsStore.delete(operation.id);
    }
  };
  const spaces = transaction.objectStore('spaces');
  spaces.delete(spaceId);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('No se pudieron borrar los datos del espacio.'));
    transaction.onabort = () => reject(transaction.error || new Error('Se canceló el borrado del espacio.'));
  });
  database.close();
}

export async function getQueuedOperations(spaceId) {
  const database = await openDatabase();
  const operations = await requestResult(database.transaction('operations').objectStore('operations').getAll());
  database.close();
  return operations
    .filter((operation) => !spaceId || operation.espacio_id === spaceId)
    .sort((left, right) => left.id - right.id);
}

export async function removeQueuedOperation(id) {
  const database = await openDatabase();
  const transaction = database.transaction('operations', 'readwrite');
  transaction.objectStore('operations').delete(id);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('No se pudo actualizar la cola local.'));
  });
  database.close();
}

export async function enqueueOperation(operation) {
  const database = await openDatabase();
  const transaction = database.transaction(['snapshot', 'operations'], 'readwrite');
  const snapshotStore = transaction.objectStore('snapshot');
  const getRequest = snapshotStore.get(ACTIVE_SNAPSHOT_KEY);
  let nextSnapshot;
  getRequest.onsuccess = () => {
    const current = getRequest.result;
    const queuedOperation = {
      ...operation,
      espacio_id: operation.payload?.espacio_id || current?.value?.espacioId || null
    };
    nextSnapshot = applyOperation(current?.value, queuedOperation);
    snapshotStore.put({ key: ACTIVE_SNAPSHOT_KEY, value: nextSnapshot });
    if (nextSnapshot.espacioId) {
      snapshotStore.put({ key: snapshotKey(nextSnapshot.espacioId), value: nextSnapshot });
    }
    transaction.objectStore('operations').add(queuedOperation);
  };
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('No se pudo guardar el cambio pendiente.'));
    transaction.onabort = () => reject(transaction.error || new Error('Se canceló el cambio pendiente.'));
  });
  database.close();
  return nextSnapshot;
}

export async function reconcileSnapshot(serverSnapshot, shouldSave = () => true) {
  const operations = await getQueuedOperations(serverSnapshot.espacioId);
  const merged = operations.reduce(applyOperation, serverSnapshot);
  await writeSnapshot(merged, shouldSave);
  return merged;
}
