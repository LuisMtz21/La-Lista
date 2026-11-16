import { createSupabaseClient, getDeviceName, isSupabaseConfigured } from './supabase.js';
import { createList, deleteList, renameList, setListArchived } from './listas.js';
import { createItem, deleteItem, updateItem } from './elementos.js';
import {
  readSnapshot,
  readSpaces,
  removeSpaceData,
  writeSnapshot,
  writeSpaces
} from './offline.js';
import { createSynchronization } from './sincronizacion.js';

const setupView = document.getElementById('setup-view');
const homeView = document.getElementById('home-view');
const detailView = document.getElementById('detail-view');
const setupError = document.getElementById('setup-error');
const syncStatus = document.getElementById('sync-status');
const syncLabel = document.getElementById('sync-label');
const listsGrid = document.getElementById('lists-grid');
const emptyState = document.getElementById('empty-state');
const toast = document.getElementById('toast');

let client = null;
let synchronization = null;
let currentUser = null;
let spaceId = null;
let snapshot = { espacioId: null, listas: [], elementos: [] };
let currentListId = null;
let currentTab = 'active';
let availableSpaces = [];
let sortMode = localStorage.getItem('la-lista-sort') || 'created';
let bootPromise = null;
let toastTimer = null;
const listCardCache = new Map();
const itemRowCache = new Map();
const itemsContainer = document.getElementById('items-list');
let completedHeading = null;
let emptyItemsHint = null;

function setStatus(state, label) {
  syncStatus.dataset.state = state;
  syncLabel.textContent = label;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2800);
}

function showSetup(message = '') {
  document.getElementById('spaces-button').hidden = !availableSpaces.length;
  setupView.hidden = false;
  homeView.hidden = true;
  detailView.hidden = true;
  setupError.hidden = !message;
  setupError.textContent = message;
}

function showHome() {
  setupView.hidden = true;
  homeView.hidden = false;
  detailView.hidden = true;
  currentListId = null;
  renderHome();
}

function showError(error, fallback = 'Ocurrió un error. Inténtalo de nuevo.') {
  console.error(error);
  const message = error instanceof Error ? error.message : fallback;
  showToast(message || fallback);
}

async function getFunctionErrorMessage(error) {
  const response = error?.context;
  if (response && typeof response.clone === 'function') {
    try {
      const body = await response.clone().json();
      if (typeof body?.error === 'string') return body.error;
    } catch {
      // Use the function client's message when the response is not JSON.
    }
  }
  return error?.message || 'No se pudo completar la solicitud.';
}

function sameRecords(left, right, fields) {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((record) => [record.id, record]));
  return left.every((record) => {
    const other = rightById.get(record.id);
    return other && fields.every((field) => {
      if (!field.startsWith('fecha_')) return record[field] === other[field];
      return new Date(record[field]).getTime() === new Date(other[field]).getTime();
    });
  });
}

function sameSnapshot(left, right) {
  return left.espacioId === right.espacioId
    && sameRecords(left.listas, right.listas, [
      'id', 'espacio_id', 'titulo', 'fecha_creacion', 'fecha_modificacion', 'archivada'
    ])
    && sameRecords(left.elementos, right.elementos, [
      'id', 'lista_id', 'texto', 'completado', 'orden', 'fecha_creacion', 'fecha_modificacion'
    ]);
}

function updateSnapshot(nextSnapshot) {
  const changed = !sameSnapshot(snapshot, nextSnapshot);
  snapshot = nextSnapshot;
  if (!changed) return;
  if (!homeView.hidden) renderHome();
  if (!detailView.hidden) renderDetail();
}

function formatDate(value) {
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(value));
}

function renderSpaces() {
  const container = document.getElementById('spaces-list');
  if (!container) return;
  const rows = availableSpaces.map((space) => {
    const row = document.createElement('div');
    row.className = 'space-row';
    const select = document.createElement('button');
    select.className = `space-select${space.id === spaceId ? ' current' : ''}`;
    select.type = 'button';
    select.dataset.spaceSelect = space.id;
    const label = document.createElement('span');
    label.className = 'space-select-label';
    const name = document.createElement('strong');
    const spaceName = space.nombre || `Espacio ${space.id.slice(0, 4)}`;
    name.textContent = spaceName;
    const meta = document.createElement('small');
    meta.textContent = space.fecha_vinculacion
      ? `Vinculado ${formatDate(space.fecha_vinculacion)}`
      : 'Listas compartidas';
    label.append(name, meta);
    select.append(label);
    if (space.id === spaceId) {
      const current = document.createElement('span');
      current.className = 'space-current';
      current.textContent = 'Actual';
      select.append(current);
    }

    const leave = document.createElement('button');
    leave.className = 'icon-button space-leave';
    leave.type = 'button';
    leave.dataset.spaceLeave = space.id;
    leave.setAttribute('aria-label', `Salir de ${spaceName}`);
    leave.title = 'Salir de este espacio';
    leave.textContent = '×';
    row.append(select, leave);
    return row;
  });
  reconcileChildren(container, rows);
  document.getElementById('spaces-button').hidden = !availableSpaces.length;
  document.getElementById('spaces-button').setAttribute(
    'aria-label',
    `Espacios${availableSpaces.length > 1 ? `, ${availableSpaces.length} disponibles` : ''}`
  );
}

async function addSpace(id, properties = {}) {
  const previous = availableSpaces.find((space) => space.id === id);
  availableSpaces = [
    ...availableSpaces.filter((space) => space.id !== id),
    {
      ...previous,
      ...properties,
      id,
      nombre: properties.nombre || previous?.nombre || `Espacio ${id.slice(0, 4)}`
    }
  ];
  await writeSpaces(availableSpaces);
  renderSpaces();
}

function reconcileChildren(container, desiredChildren) {
  let position = container.firstElementChild;
  for (const child of desiredChildren) {
    if (child !== position) container.insertBefore(child, position);
    position = child.nextElementSibling;
  }
  while (position) {
    const next = position.nextElementSibling;
    position.remove();
    position = next;
  }
}

function itemCounts(listId) {
  const items = snapshot.elementos.filter((item) => item.lista_id === listId);
  return { total: items.length, complete: items.filter((item) => item.completado).length };
}

function createCard(list) {
  const card = document.createElement('article');
  card.className = 'list-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.dataset.listId = list.id;
  card.innerHTML = `
    <div class="card-menu dropdown">
      <button class="icon-button" type="button" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Opciones de ${escapeHtml(list.titulo)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle></svg>
      </button>
      <ul class="dropdown-menu dropdown-menu-end">
        <li><button class="dropdown-item" type="button" data-list-action="rename">Cambiar título</button></li>
        <li><button class="dropdown-item" type="button" data-list-action="archive"></button></li>
        <li><hr class="dropdown-divider"></li>
        <li><button class="dropdown-item text-danger" type="button" data-list-action="delete">Eliminar lista</button></li>
      </ul>
    </div>
    <h2 class="card-title"></h2>
    <p class="card-date"></p>
    <div class="card-progress">
      <span></span>
      <div class="progress-track"><div class="progress-fill"></div></div>
    </div>`;
  return card;
}

function updateCard(card, list) {
  const counts = itemCounts(list.id);
  const progress = counts.total ? Math.round((counts.complete / counts.total) * 100) : 0;
  card.setAttribute('aria-label', `Abrir lista ${list.titulo}`);
  card.querySelector('.card-menu > button').setAttribute('aria-label', `Opciones de ${list.titulo}`);
  card.querySelector('.card-title').textContent = list.titulo;
  card.querySelector('.card-date').textContent = formatDate(list.fecha_creacion);
  card.querySelector('.card-progress > span').textContent = `${counts.complete} de ${counts.total} elementos`;
  card.querySelector('.progress-track').setAttribute('aria-label', `${progress}% completado`);
  card.querySelector('.progress-fill').style.width = `${progress}%`;
  const archiveAction = card.querySelector('[data-list-action="archive"], [data-list-action="restore"]');
  archiveAction.dataset.listAction = list.archivada ? 'restore' : 'archive';
  archiveAction.textContent = list.archivada ? 'Recuperar lista' : 'Archivar lista';
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function renderHome() {
  const query = document.getElementById('search-input').value.trim().toLocaleLowerCase('es');
  const isArchived = currentTab === 'archived';
  const lists = snapshot.listas
    .filter((list) => list.archivada === isArchived)
    .filter((list) => list.titulo.toLocaleLowerCase('es').includes(query))
    .sort((left, right) => new Date(right.fecha_creacion) - new Date(left.fecha_creacion));
  const existingIds = new Set(snapshot.listas.map((list) => list.id));
  for (const [id, card] of listCardCache) {
    if (!existingIds.has(id)) {
      card.remove();
      listCardCache.delete(id);
    }
  }
  const cards = lists.map((list) => {
    let card = listCardCache.get(list.id);
    if (!card) {
      card = createCard(list);
      listCardCache.set(list.id, card);
    }
    updateCard(card, list);
    return card;
  });
  reconcileChildren(listsGrid, cards);
  listsGrid.hidden = lists.length === 0;
  emptyState.hidden = lists.length > 0;

  const noMatches = query.length > 0;
  document.getElementById('empty-title').textContent = noMatches
    ? 'No encontramos esa lista'
    : isArchived ? 'No hay listas archivadas' : 'Todavía no hay listas';
  document.getElementById('empty-description').textContent = noMatches
    ? 'Prueba con otro título.'
    : isArchived ? 'Las listas que archives aparecerán aquí.' : 'Crea tu primera lista y compártela al instante.';
  document.getElementById('empty-create-button').hidden = isArchived || noMatches;
  document.getElementById('home-heading').textContent = isArchived ? 'Archivadas' : 'Mis listas';
}

function sortedItems(items) {
  return [...items].sort((left, right) => {
    if (left.completado !== right.completado) return Number(left.completado) - Number(right.completado);
    if (sortMode === 'alpha') {
      return left.texto.localeCompare(right.texto, 'es', { sensitivity: 'base' })
        || new Date(left.fecha_creacion) - new Date(right.fecha_creacion);
    }
    return new Date(left.fecha_creacion) - new Date(right.fecha_creacion)
      || left.orden - right.orden
      || left.id.localeCompare(right.id);
  });
}

function beginEditItem(item, textElement) {
  const input = document.createElement('input');
  input.className = 'item-edit';
  input.type = 'text';
  input.maxLength = 500;
  input.value = item.texto;
  input.setAttribute('aria-label', 'Editar elemento');
  textElement.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const text = input.value.trim();
    input.replaceWith(textElement);
    const latestItem = snapshot.elementos.find((entry) => entry.id === item.id) || item;
    if (save && text && text !== latestItem.texto) {
      textElement.textContent = text;
      try {
        await commit(() => updateItem(item.id, { texto: text }));
      } catch (error) {
        showError(error);
      }
    } else {
      textElement.textContent = latestItem.texto;
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      void finish(false);
    }
  });
  itemsContainer.addEventListener('keydown', (event) => {
    const text = event.target.closest('[data-item-action="edit"]');
    if (!text || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    const item = snapshot.elementos.find((entry) => entry.id === text.dataset.itemId);
    if (item) beginEditItem(item, text);
  });
  input.addEventListener('blur', () => void finish(true));
}

function createItemRow(item) {
  const row = document.createElement('div');
  row.className = 'item-row';
  row.dataset.itemId = item.id;
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'item-check';
  checkbox.dataset.itemAction = 'toggle';

  const text = document.createElement('span');
  text.className = 'item-text';
  text.tabIndex = 0;
  text.setAttribute('role', 'button');
  text.dataset.itemAction = 'edit';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-button item-delete';
  remove.textContent = '×';
  remove.dataset.itemAction = 'delete';
  row.append(checkbox, text, remove);
  return row;
}

function updateItemRow(row, item) {
  row.classList.toggle('completed', item.completado);
  const checkbox = row.querySelector('.item-check');
  checkbox.checked = item.completado;
  checkbox.dataset.itemId = item.id;
  checkbox.setAttribute('aria-label', item.completado ? `Desmarcar ${item.texto}` : `Completar ${item.texto}`);
  const text = row.querySelector('.item-text');
  if (text) {
    text.textContent = item.texto;
    text.dataset.itemId = item.id;
    text.setAttribute('aria-label', `Editar ${item.texto}`);
  }
  const remove = row.querySelector('.item-delete');
  remove.dataset.itemId = item.id;
  remove.setAttribute('aria-label', `Eliminar ${item.texto}`);
}

function getItemRow(item) {
  let row = itemRowCache.get(item.id);
  if (!row) {
    row = createItemRow(item);
    itemRowCache.set(item.id, row);
  }
  updateItemRow(row, item);
  return row;
}

function renderDetail() {
  const list = snapshot.listas.find((entry) => entry.id === currentListId);
  if (!list) {
    showHome();
    return;
  }
  const items = sortedItems(snapshot.elementos.filter((item) => item.lista_id === list.id));
  const completedCount = items.filter((item) => item.completado).length;
  document.getElementById('detail-title').textContent = list.titulo;
  document.getElementById('detail-subtitle').textContent =
    `${formatDate(list.fecha_creacion)} · ${completedCount} de ${items.length} completados`;
  document.getElementById('sort-select').value = sortMode;
  document.getElementById('archive-list-button').textContent = list.archivada ? 'Recuperar lista' : 'Archivar lista';

  const visibleIds = new Set(snapshot.elementos.map((item) => item.id));
  for (const [id, row] of itemRowCache) {
    if (!visibleIds.has(id)) {
      row.remove();
      itemRowCache.delete(id);
    }
  }
  const pending = items.filter((item) => !item.completado).map(getItemRow);
  const completed = items.filter((item) => item.completado).map(getItemRow);
  const rows = [...pending];
  if (completed.length) {
    if (!completedHeading) {
      completedHeading = document.createElement('h2');
      completedHeading.className = 'completed-label';
      completedHeading.textContent = 'Completados';
    }
    rows.push(completedHeading, ...completed);
  }
  if (!items.length) {
    if (!emptyItemsHint) {
      emptyItemsHint = document.createElement('p');
      emptyItemsHint.className = 'empty-hint text-center py-4';
      emptyItemsHint.textContent = 'Agrega el primer elemento a esta lista.';
    }
    rows.push(emptyItemsHint);
  }
  reconcileChildren(itemsContainer, rows);
}

function showDetail(listId) {
  currentListId = listId;
  setupView.hidden = true;
  homeView.hidden = true;
  detailView.hidden = false;
  renderDetail();
}

async function commit(action) {
  await action();
  updateSnapshot(await readSnapshot());
  if (!navigator.onLine) {
    setStatus('offline', 'Sin conexión');
    showToast('Guardado en este dispositivo. Se sincronizará al recuperar conexión.');
  } else if (synchronization) {
    void synchronization.flush().catch(showError);
  }
}

async function ensureSession() {
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (sessionData.session) {
    currentUser = sessionData.session.user;
    return sessionData.session;
  }
  if (!navigator.onLine) throw new Error('Conéctate a internet para vincular este dispositivo.');

  const { data, error } = await client.auth.signInAnonymously({
    options: { data: { nombre_dispositivo: getDeviceName() } }
  });
  if (error) throw error;
  currentUser = data.user;
  return data.session;
}

async function showWorkspace(space) {
  synchronization?.stop();
  spaceId = space;
  snapshot = await readSnapshot(space);
  await writeSnapshot(snapshot);
  renderSpaces();
  if (!synchronization) {
    synchronization = createSynchronization(client, updateSnapshot, setStatus);
  }
  showHome();
  await synchronization.start(space).catch((error) => {
    console.error('No se pudo iniciar la sincronización:', error);
    setStatus(navigator.onLine ? 'error' : 'offline', navigator.onLine ? 'Error de sincronización' : 'Sin conexión');
  });
}

async function redeemInvitation(input) {
  let code = input.trim();
  if (!code) throw new Error('Pega el enlace o el código de invitación.');
  try {
    const url = new URL(code);
    code = url.searchParams.get('invite') || code;
  } catch {
    // The value is already a raw invitation code.
  }
  const tokenMatch = code.match(/^[A-Za-z0-9_-]{40,50}$/);
  if (!tokenMatch) throw new Error('El enlace o código de invitación no es válido.');
  await ensureSession();
  const { data, error } = await client.functions.invoke('canjear-invitacion', {
    body: { codigo: code, nombreDispositivo: getDeviceName() }
  });
  if (error) throw new Error(await getFunctionErrorMessage(error));
  if (!data?.espacioId) throw new Error('No se pudo vincular este dispositivo.');
  await addSpace(data.espacioId);
  history.replaceState(null, '', location.pathname);
  await showWorkspace(data.espacioId);
  showToast('Dispositivo vinculado.');
}

async function boot() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    snapshot = await readSnapshot();
    availableSpaces = await readSpaces();
    renderSpaces();
    if (!isSupabaseConfigured()) {
      showSetup('Configura la URL y la clave pública anon de Supabase en js/config.js.');
      setStatus('error', 'Falta configurar Supabase');
      return;
    }
    client = createSupabaseClient();

    let session;
    try {
      session = await ensureSession();
    } catch (error) {
      if (!navigator.onLine && snapshot.espacioId) {
        await addSpace(snapshot.espacioId);
        await showWorkspace(snapshot.espacioId);
        setStatus('offline', 'Sin conexión');
        return;
      }
      showSetup(error.message);
      setStatus(navigator.onLine ? 'error' : 'offline', navigator.onLine ? 'Error de sincronización' : 'Sin conexión');
      return;
    }

    currentUser = session.user;
    if (!navigator.onLine && snapshot.espacioId) {
      if (!availableSpaces.some((space) => space.id === snapshot.espacioId)) {
        await addSpace(snapshot.espacioId);
      }
      await showWorkspace(snapshot.espacioId);
      setStatus('offline', 'Sin conexión');
      return;
    }

    const { data: devices, error } = await client
      .from('dispositivos')
      .select('espacio_id')
      .eq('auth_user_id', currentUser.id)
      .is('revocado_en', null)
      .order('fecha_vinculacion', { ascending: true });
    if (error) {
      showSetup(`No se pudo consultar el espacio: ${error.message}`);
      setStatus('error', 'Error de sincronización');
      return;
    }
    availableSpaces = devices.map((device) => ({
      id: device.espacio_id,
      nombre: `Espacio ${device.espacio_id.slice(0, 4)}`
    }));
    await writeSpaces(availableSpaces);
    renderSpaces();

    const invitation = new URLSearchParams(location.search).get('invite');
    if (invitation) {
      document.getElementById('invite-code').value = invitation;
      document.getElementById('space-invite-input').value = invitation;
      try {
        await redeemInvitation(invitation);
        return;
      } catch (error) {
        history.replaceState(null, '', location.pathname);
        if (availableSpaces.length) {
          await showWorkspace(availableSpaces[0].id);
          const label = document.getElementById('spaces-error');
          label.textContent = error.message || 'No se pudo vincular este dispositivo.';
          label.hidden = false;
          document.getElementById('spaces-dialog').showModal();
          return;
        }
        showSetup(error.message);
        return;
      }
    }

    if (availableSpaces.length) {
      const selectedSpace = availableSpaces.find((space) => space.id === snapshot.espacioId) || availableSpaces[0];
      await showWorkspace(selectedSpace.id);
      return;
    }

    if (snapshot.espacioId) {
      await removeSpaceData(snapshot.espacioId);
      snapshot = { espacioId: null, listas: [], elementos: [] };
    }
    showSetup();
    setStatus('synced', 'Sincronizado');
  })();
  try {
    await bootPromise;
  } finally {
    bootPromise = null;
  }
}

function setActiveTab(tab) {
  currentTab = tab;
  document.getElementById('active-tab').classList.toggle('active', tab === 'active');
  document.getElementById('active-tab').setAttribute('aria-selected', String(tab === 'active'));
  document.getElementById('archived-tab').classList.toggle('active', tab === 'archived');
  document.getElementById('archived-tab').setAttribute('aria-selected', String(tab === 'archived'));
  renderHome();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('la-lista-theme', theme);
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#1d201e' : '#f7f6f2';
  document.getElementById('theme-toggle').setAttribute('aria-label', theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
}

async function loadDevices() {
  const deviceList = document.getElementById('devices-list');
  const errorLabel = document.getElementById('devices-error');
  deviceList.replaceChildren();
  errorLabel.hidden = true;
  const { data, error } = await client
    .from('dispositivos')
    .select('id, auth_user_id, nombre_dispositivo, fecha_vinculacion, revocado_en')
    .eq('espacio_id', spaceId)
    .order('fecha_vinculacion', { ascending: true });
  if (error) {
    errorLabel.textContent = `No se pudieron cargar los dispositivos: ${error.message}`;
    errorLabel.hidden = false;
    return;
  }

  for (const device of data) {
    const row = document.createElement('div');
    row.className = 'device-row';
    const info = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'device-name';
    name.textContent = device.auth_user_id === currentUser?.id
      ? `${device.nombre_dispositivo} · Este dispositivo`
      : device.nombre_dispositivo;
    const meta = document.createElement('p');
    meta.className = 'device-meta';
    meta.textContent = device.revocado_en
      ? `Revocado ${formatDate(device.revocado_en)}`
      : `Vinculado ${formatDate(device.fecha_vinculacion)}`;
    info.append(name, meta);
    row.append(info);
    if (!device.revocado_en && device.auth_user_id !== currentUser?.id) {
      const revoke = document.createElement('button');
      revoke.className = 'btn btn-light';
      revoke.type = 'button';
      revoke.textContent = 'Revocar';
      revoke.addEventListener('click', async () => {
        if (!window.confirm(`¿Revocar el acceso de “${device.nombre_dispositivo}”?`)) return;
        revoke.disabled = true;
        const { data: updated, error: revokeError } = await client
          .from('dispositivos')
          .update({ revocado_en: new Date().toISOString() })
          .eq('id', device.id)
          .neq('auth_user_id', currentUser.id)
          .select('id');
        if (revokeError) {
          revoke.disabled = false;
          errorLabel.textContent = `No se pudo revocar el dispositivo: ${revokeError.message}`;
          errorLabel.hidden = false;
          return;
        }
        if (!updated.length) {
          revoke.disabled = false;
          errorLabel.textContent = 'El dispositivo ya no está disponible para revocación.';
          errorLabel.hidden = false;
          return;
        }
        showToast('Dispositivo revocado.');
        await loadDevices();
      });
      row.append(revoke);
    }
    deviceList.append(row);
  }
}

async function verifyDeviceAccess() {
  if (!client || !currentUser || !spaceId || !navigator.onLine) return;
  const { data, error } = await client
    .from('dispositivos')
    .select('espacio_id')
    .eq('auth_user_id', currentUser.id)
    .eq('espacio_id', spaceId)
    .is('revocado_en', null)
    .maybeSingle();
  if (error) {
    console.error('No se pudo verificar el acceso del dispositivo:', error);
    setStatus('error', 'Error de sincronización');
    return;
  }
  if (data) return;

  const revokedSpace = spaceId;
  synchronization?.stop();
  await removeSpaceData(revokedSpace);
  availableSpaces = availableSpaces.filter((space) => space.id !== revokedSpace);
  await writeSpaces(availableSpaces);
  snapshot = { espacioId: null, listas: [], elementos: [] };
  spaceId = null;
  renderSpaces();
  if (availableSpaces.length) {
    await showWorkspace(availableSpaces[0].id);
    showToast('El acceso a uno de tus espacios fue revocado.');
    return;
  }
  showSetup('El acceso de este dispositivo fue revocado. Puedes volver a vincularlo con una nueva invitación.');
  setStatus('error', 'Acceso revocado');
}

async function createWorkspace() {
  await ensureSession();
  const { data, error } = await client.functions.invoke('crear-espacio', { body: {} });
  if (error) throw new Error(await getFunctionErrorMessage(error));
  if (!data?.espacioId) throw new Error('No se recibió el espacio compartido.');
  await addSpace(data.espacioId);
  await showWorkspace(data.espacioId);
  showToast('Espacio creado. Comparte una invitación para vincular a otra persona.');
}

async function leaveSpace(id) {
  if (!navigator.onLine) throw new Error('Conéctate a internet para salir del espacio de forma segura.');
  const space = availableSpaces.find((entry) => entry.id === id);
  const name = space?.nombre || 'este espacio';
  if (!window.confirm(`¿Salir de “${name}”? Se revocará este dispositivo y se borrarán de él los datos sin conexión de este espacio. Para volver necesitarás una invitación nueva.`)) return;

  const { data, error } = await client.rpc('salir_espacio', { p_espacio_id: id });
  if (error) throw error;
  if (!data) throw new Error('Este dispositivo ya no tiene acceso a ese espacio.');

  const wasCurrent = spaceId === id;
  if (wasCurrent) synchronization?.stop();
  await removeSpaceData(id);
  availableSpaces = availableSpaces.filter((entry) => entry.id !== id);
  await writeSpaces(availableSpaces);
  renderSpaces();
  if (!wasCurrent) {
    showToast('Saliste del espacio.');
    return;
  }
  if (availableSpaces.length) {
    await showWorkspace(availableSpaces[0].id);
  } else {
    synchronization?.stop();
    spaceId = null;
    snapshot = { espacioId: null, listas: [], elementos: [] };
    showSetup();
    setStatus('synced', 'Sincronizado');
  }
  showToast('Saliste del espacio.');
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

document.getElementById('active-tab').addEventListener('click', () => setActiveTab('active'));
document.getElementById('archived-tab').addEventListener('click', () => setActiveTab('archived'));
document.getElementById('search-input').addEventListener('input', renderHome);
document.getElementById('new-list-button').addEventListener('click', () => {
  document.getElementById('list-title-input').value = '';
  document.getElementById('list-form-error').hidden = true;
  document.getElementById('list-dialog').showModal();
  document.getElementById('list-title-input').focus();
});
document.getElementById('empty-create-button').addEventListener('click', () => document.getElementById('new-list-button').click());

document.getElementById('create-list-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = document.getElementById('list-title-input').value;
  try {
    await commit(() => createList(spaceId, title));
    document.getElementById('list-dialog').close();
    showToast('Lista creada.');
  } catch (error) {
    const label = document.getElementById('list-form-error');
    label.textContent = error.message;
    label.hidden = false;
  }
});

listsGrid.addEventListener('click', async (event) => {
  const card = event.target.closest('.list-card');
  if (!card) return;
  const listId = card.dataset.listId;
  const action = event.target.closest('[data-list-action]')?.dataset.listAction;
  if (!action) {
    if (!event.target.closest('.card-menu')) showDetail(listId);
    return;
  }
  const list = snapshot.listas.find((entry) => entry.id === listId);
  if (!list) return;
  try {
    if (action === 'rename') {
      const title = window.prompt('Nuevo título', list.titulo);
      if (title === null) return;
      await commit(() => renameList(listId, title));
      showToast('Título actualizado.');
    } else if (action === 'archive' || action === 'restore') {
      await commit(() => setListArchived(listId, action === 'archive'));
      showToast(action === 'archive' ? 'Lista archivada.' : 'Lista recuperada.');
    } else if (action === 'delete') {
      if (!window.confirm(`¿Eliminar la lista “${list.titulo}” y sus elementos?`)) return;
      await commit(() => deleteList(listId));
      showToast('Lista eliminada.');
    }
  } catch (error) {
    showError(error);
  }
});

listsGrid.addEventListener('keydown', (event) => {
  const card = event.target.closest('.list-card');
  if (card && event.target === card && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    showDetail(card.dataset.listId);
  }
});

document.getElementById('back-button').addEventListener('click', showHome);
document.getElementById('sort-select').addEventListener('change', (event) => {
  sortMode = event.target.value;
  localStorage.setItem('la-lista-sort', sortMode);
  renderDetail();
});
document.getElementById('add-item-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('new-item-input');
  if (!input.value.trim()) {
    input.focus();
    return;
  }
  try {
    await commit(() => createItem(currentListId, input.value));
    input.value = '';
    input.focus();
  } catch (error) {
    showError(error);
  }
});

itemsContainer.addEventListener('change', async (event) => {
  const checkbox = event.target.closest('[data-item-action="toggle"]');
  if (!checkbox) return;
  try {
    await commit(() => updateItem(checkbox.dataset.itemId, { completado: checkbox.checked }));
  } catch (error) {
    showError(error);
  }
});
itemsContainer.addEventListener('click', async (event) => {
  const text = event.target.closest('[data-item-action="edit"]');
  if (text) {
    const item = snapshot.elementos.find((entry) => entry.id === text.dataset.itemId);
    if (item) beginEditItem(item, text);
    return;
  }
  const button = event.target.closest('[data-item-action="delete"]');
  if (!button) return;
  try {
    await commit(() => deleteItem(button.dataset.itemId));
    showToast('Elemento eliminado.');
  } catch (error) {
    showError(error);
  }
});

document.getElementById('rename-list-button').addEventListener('click', async () => {
  const list = snapshot.listas.find((entry) => entry.id === currentListId);
  if (!list) return;
  const title = window.prompt('Nuevo título', list.titulo);
  if (title === null) return;
  try {
    await commit(() => renameList(list.id, title));
    showToast('Título actualizado.');
  } catch (error) {
    showError(error);
  }
});

document.getElementById('archive-list-button').addEventListener('click', async () => {
  const list = snapshot.listas.find((entry) => entry.id === currentListId);
  if (!list) return;
  try {
    await commit(() => setListArchived(list.id, !list.archivada));
    showHome();
    showToast(list.archivada ? 'Lista recuperada.' : 'Lista archivada.');
  } catch (error) {
    showError(error);
  }
});

document.getElementById('delete-list-button').addEventListener('click', async () => {
  const list = snapshot.listas.find((entry) => entry.id === currentListId);
  if (!list || !window.confirm(`¿Eliminar la lista “${list.titulo}” y sus elementos?`)) return;
  try {
    await commit(() => deleteList(list.id));
    showHome();
    showToast('Lista eliminada.');
  } catch (error) {
    showError(error);
  }
});

document.getElementById('devices-button').addEventListener('click', async () => {
  document.getElementById('invite-result').hidden = true;
  document.getElementById('invite-copy-status').textContent = '';
  document.getElementById('devices-dialog').showModal();
  await loadDevices();
});
document.getElementById('create-invite-button').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  document.getElementById('devices-error').hidden = true;
  try {
    const { data, error } = await client.functions.invoke('crear-invitacion', { body: { espacioId: spaceId } });
    if (error) throw new Error(await getFunctionErrorMessage(error));
    if (!data?.codigo) throw new Error('No se recibió el enlace de invitación.');
    const inviteUrl = new URL(location.href);
    inviteUrl.search = '';
    inviteUrl.hash = '';
    inviteUrl.searchParams.set('invite', data.codigo);
    document.getElementById('invite-link').value = inviteUrl.toString();
    document.getElementById('invite-result').hidden = false;
  } catch (error) {
    const label = document.getElementById('devices-error');
    label.textContent = await getFunctionErrorMessage(error);
    label.hidden = false;
  } finally {
    button.disabled = false;
  }
});
document.getElementById('copy-invite-button').addEventListener('click', async () => {
  const input = document.getElementById('invite-link');
  const status = document.getElementById('invite-copy-status');
  try {
    await navigator.clipboard.writeText(input.value);
    status.textContent = 'Enlace copiado.';
  } catch {
    input.focus();
    input.select();
    const copied = document.execCommand('copy');
    status.textContent = copied ? 'Enlace copiado.' : 'Selecciona y copia el enlace.';
  }
});

document.getElementById('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await redeemInvitation(document.getElementById('invite-code').value);
  } catch (error) {
    showSetup(error.message || 'No se pudo vincular este dispositivo.');
  }
});

document.getElementById('create-space').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  setupError.hidden = true;
  try {
    await createWorkspace();
  } catch (error) {
    showSetup(await getFunctionErrorMessage(error));
  } finally {
    button.disabled = false;
  }
});

document.getElementById('spaces-button').addEventListener('click', () => {
  document.getElementById('spaces-error').hidden = true;
  renderSpaces();
  document.getElementById('spaces-dialog').showModal();
});
document.getElementById('spaces-list').addEventListener('click', async (event) => {
  const leaveButton = event.target.closest('[data-space-leave]');
  if (leaveButton) {
    try {
      await leaveSpace(leaveButton.dataset.spaceLeave);
    } catch (error) {
      const label = document.getElementById('spaces-error');
      label.textContent = error.message || 'No se pudo salir del espacio.';
      label.hidden = false;
    }
    return;
  }

  const selectButton = event.target.closest('[data-space-select]');
  if (!selectButton || selectButton.dataset.spaceSelect === spaceId) {
    document.getElementById('spaces-dialog').close();
    return;
  }
  try {
    await showWorkspace(selectButton.dataset.spaceSelect);
    document.getElementById('spaces-dialog').close();
  } catch (error) {
    showError(error);
  }
});
document.getElementById('create-space-from-switcher').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  document.getElementById('spaces-error').hidden = true;
  try {
    await createWorkspace();
    document.getElementById('spaces-dialog').close();
  } catch (error) {
    const label = document.getElementById('spaces-error');
    label.textContent = await getFunctionErrorMessage(error);
    label.hidden = false;
  } finally {
    button.disabled = false;
  }
});
document.getElementById('join-space-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('space-invite-input');
  const button = event.currentTarget.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  document.getElementById('spaces-error').hidden = true;
  try {
    await redeemInvitation(input.value);
    input.value = '';
    document.getElementById('spaces-dialog').close();
  } catch (error) {
    const label = document.getElementById('spaces-error');
    label.textContent = error.message || 'No se pudo vincular este dispositivo.';
    label.hidden = false;
  } finally {
    if (button) button.disabled = false;
  }
});

window.addEventListener('offline', () => setStatus('offline', 'Sin conexión'));
window.addEventListener('online', () => {
  if (synchronization) {
    void verifyDeviceAccess().then(() => {
      if (spaceId) return synchronization.reconnect();
    }).catch(showError);
  }
  else void boot().catch((error) => {
    showError(error);
    setStatus('error', 'Error de sincronización');
  });
});
window.addEventListener('focus', () => {
  if (navigator.onLine) void verifyDeviceAccess().catch(showError);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && navigator.onLine) {
    void verifyDeviceAccess().catch(showError);
  }
});
setInterval(() => {
  if (document.visibilityState === 'visible' && navigator.onLine) {
    void verifyDeviceAccess().catch(showError);
  }
}, 60_000);

const savedTheme = localStorage.getItem('la-lista-theme')
  || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
applyTheme(savedTheme);
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((error) => {
      console.error('No se pudo registrar el service worker:', error);
    });
  });
}
void boot().catch((error) => {
  console.error('No se pudo iniciar La Lista:', error);
  showSetup(error.message || 'No se pudo iniciar la aplicación.');
  setStatus('error', 'Error de sincronización');
});
