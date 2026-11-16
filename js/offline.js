const DATABASE_NAME = 'la-lista-local';
const DATABASE_VERSION = 1;
const SNAPSHOT_KEY = 'shared-space';

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

export async function readSnapshot() {
  const database = await openDatabase();
  const entry = await requestResult(database.transaction('snapshot').objectStore('snapshot').get(SNAPSHOT_KEY));
  database.close();
  return entry?.value || { espacioId: null, listas: [], elementos: [] };
}

export async function writeSnapshot(snapshot) {
  const database = await openDatabase();
  const transaction = database.transaction('snapshot', 'readwrite');
  transaction.objectStore('snapshot').put({ key: SNAPSHOT_KEY, value: snapshot });
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('No se pudo guardar la caché local.'));
    transaction.onabort = () => reject(transaction.error || new Error('Se canceló el guardado local.'));
  });
  database.close();
}

export async function clearLocalData() {
  const database = await openDatabase();
  const transaction = database.transaction(['snapshot', 'operations'], 'readwrite');
  transaction.objectStore('snapshot').clear();
  transaction.objectStore('operations').clear();
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('No se pudieron borrar los datos locales.'));
    transaction.onabort = () => reject(transaction.error || new Error('Se canceló el borrado local.'));
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
  const getRequest = snapshotStore.get(SNAPSHOT_KEY);
  let nextSnapshot;
  getRequest.onsuccess = () => {
    const current = getRequest.result;
    const queuedOperation = {
      ...operation,
      espacio_id: operation.payload?.espacio_id || current?.value?.espacioId || null
    };
    nextSnapshot = applyOperation(current?.value, queuedOperation);
    snapshotStore.put({ key: SNAPSHOT_KEY, value: nextSnapshot });
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

export async function reconcileSnapshot(serverSnapshot) {
  const operations = await getQueuedOperations(serverSnapshot.espacioId);
  const merged = operations.reduce(applyOperation, serverSnapshot);
  await writeSnapshot(merged);
  return merged;
}
