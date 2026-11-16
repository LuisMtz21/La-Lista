import { enqueueOperation, readSnapshot } from './offline.js';

function now() {
  return new Date().toISOString();
}

function normalizeText(text) {
  const value = text.trim();
  if (!value) throw new Error('El elemento no puede estar vacío.');
  if (value.length > 500) throw new Error('El elemento no puede superar 500 caracteres.');
  return value;
}

export async function createItem(listId, text) {
  const snapshot = await readSnapshot();
  const list = snapshot.listas.find((entry) => entry.id === listId);
  if (!list) throw new Error('No se encontró la lista.');
  const order = snapshot.elementos
    .filter((item) => item.lista_id === listId)
    .reduce((maximum, item) => Math.max(maximum, item.orden), 0) + 1;
  const timestamp = now();
  const item = {
    id: crypto.randomUUID(),
    lista_id: listId,
    texto: normalizeText(text),
    completado: false,
    orden: order,
    fecha_creacion: timestamp,
    fecha_modificacion: timestamp
  };
  await enqueueOperation({ type: 'item_upsert', payload: item });
  return item;
}

export async function updateItem(itemId, changes) {
  const snapshot = await readSnapshot();
  const item = snapshot.elementos.find((entry) => entry.id === itemId);
  if (!item) throw new Error('No se encontró el elemento.');
  const updated = {
    ...item,
    ...changes,
    texto: changes.texto === undefined ? item.texto : normalizeText(changes.texto),
    fecha_modificacion: now()
  };
  await enqueueOperation({ type: 'item_upsert', payload: updated });
  return updated;
}

export async function deleteItem(itemId) {
  await enqueueOperation({ type: 'item_delete', payload: { id: itemId } });
}
