import { enqueueOperation, readSnapshot } from './offline.js';

function now() {
  return new Date().toISOString();
}

function normalizeTitle(title) {
  const value = title.trim();
  if (!value) throw new Error('El título no puede estar vacío.');
  if (value.length > 120) throw new Error('El título no puede superar 120 caracteres.');
  return value;
}

export async function createList(spaceId, title) {
  const timestamp = now();
  const list = {
    id: crypto.randomUUID(),
    espacio_id: spaceId,
    titulo: normalizeTitle(title),
    fecha_creacion: timestamp,
    fecha_modificacion: timestamp,
    archivada: false
  };
  await enqueueOperation({ type: 'list_upsert', payload: list });
  return list;
}

export async function renameList(listId, title) {
  const snapshot = await readSnapshot();
  const list = snapshot.listas.find((entry) => entry.id === listId);
  if (!list) throw new Error('No se encontró la lista.');
  const updated = { ...list, titulo: normalizeTitle(title), fecha_modificacion: now() };
  await enqueueOperation({ type: 'list_upsert', payload: updated });
  return updated;
}

export async function setListArchived(listId, archived) {
  const snapshot = await readSnapshot();
  const list = snapshot.listas.find((entry) => entry.id === listId);
  if (!list) throw new Error('No se encontró la lista.');
  const updated = { ...list, archivada: archived, fecha_modificacion: now() };
  await enqueueOperation({ type: 'list_upsert', payload: updated });
  return updated;
}

export async function deleteList(listId) {
  await enqueueOperation({ type: 'list_delete', payload: { id: listId } });
}
