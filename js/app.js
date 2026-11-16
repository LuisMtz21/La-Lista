import { createSupabaseClient, getDeviceName, isSupabaseConfigured } from './supabase.js';
import { createList, deleteList, renameList, setListArchived } from './listas.js';
import { createItem, deleteItem, updateItem } from './elementos.js';
import { clearLocalData, readSnapshot, writeSnapshot } from './offline.js';
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
let sortMode = localStorage.getItem('la-lista-sort') || 'created';
let bootPromise = null;
let toastTimer = null;

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

function updateSnapshot(nextSnapshot) {
  snapshot = nextSnapshot;
  if (!homeView.hidden) renderHome();
  if (!detailView.hidden) renderDetail();
}

function formatDate(value) {
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(value));
}

function itemCounts(listId) {
  const items = snapshot.elementos.filter((item) => item.lista_id === listId);
  return { total: items.length, complete: items.filter((item) => item.completado).length };
}

function createCard(list) {
  const counts = itemCounts(list.id);
  const card = document.createElement('article');
  card.className = 'list-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Abrir lista ${list.titulo}`);
  card.dataset.listId = list.id;
  const progress = counts.total ? Math.round((counts.complete / counts.total) * 100) : 0;
  card.innerHTML = `
    <div class="card-menu dropdown">
      <button class="icon-button" type="button" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Opciones de ${escapeHtml(list.titulo)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle></svg>
      </button>
      <ul class="dropdown-menu dropdown-menu-end">
        <li><button class="dropdown-item" type="button" data-list-action="rename">Cambiar título</button></li>
        <li><button class="dropdown-item" type="button" data-list-action="${list.archivada ? 'restore' : 'archive'}">${list.archivada ? 'Recuperar lista' : 'Archivar lista'}</button></li>
        <li><hr class="dropdown-divider"></li>
        <li><button class="dropdown-item text-danger" type="button" data-list-action="delete">Eliminar lista</button></li>
      </ul>
    </div>
    <h2 class="card-title">${escapeHtml(list.titulo)}</h2>
    <p class="card-date">${formatDate(list.fecha_creacion)}</p>
    <div class="card-progress">
      <span>${counts.complete} de ${counts.total} elementos</span>
      <div class="progress-track" aria-label="${progress}% completado"><div class="progress-fill" style="width:${progress}%"></div></div>
    </div>`;
  return card;
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
  listsGrid.replaceChildren(...lists.map(createCard));
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
    if (save && text && text !== item.texto) {
      try {
        await commit(() => updateItem(item.id, { texto: text }));
      } catch (error) {
        showError(error);
      }
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
  input.addEventListener('blur', () => void finish(true));
}

function createItemRow(item) {
  const row = document.createElement('div');
  row.className = `item-row${item.completado ? ' completed' : ''}`;
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'item-check';
  checkbox.checked = item.completado;
  checkbox.setAttribute('aria-label', item.completado ? `Desmarcar ${item.texto}` : `Completar ${item.texto}`);
  checkbox.dataset.itemAction = 'toggle';
  checkbox.dataset.itemId = item.id;

  const text = document.createElement('span');
  text.className = 'item-text';
  text.textContent = item.texto;
  text.tabIndex = 0;
  text.setAttribute('role', 'button');
  text.setAttribute('aria-label', `Editar ${item.texto}`);
  text.addEventListener('click', () => beginEditItem(item, text));
  text.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      beginEditItem(item, text);
    }
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-button item-delete';
  remove.textContent = '×';
  remove.setAttribute('aria-label', `Eliminar ${item.texto}`);
  remove.dataset.itemAction = 'delete';
  remove.dataset.itemId = item.id;
  row.append(checkbox, text, remove);
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

  const pending = items.filter((item) => !item.completado).map(createItemRow);
  const completed = items.filter((item) => item.completado).map(createItemRow);
  const rows = [...pending];
  if (completed.length) {
    const heading = document.createElement('h2');
    heading.className = 'completed-label';
    heading.textContent = 'Completados';
    rows.push(heading, ...completed);
  }
  if (!items.length) {
    const hint = document.createElement('p');
    hint.className = 'empty-hint text-center py-4';
    hint.textContent = 'Agrega el primer elemento a esta lista.';
    rows.push(hint);
  }
  document.getElementById('items-list').replaceChildren(...rows);
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
  snapshot = await readSnapshot();
  updateSnapshot(snapshot);
  if (!navigator.onLine) {
    setStatus('offline', 'Sin conexión');
    showToast('Guardado en este dispositivo. Se sincronizará al recuperar conexión.');
  } else if (synchronization) {
    void synchronization.reconnect().catch(showError);
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
  if (snapshot.espacioId && snapshot.espacioId !== space) {
    snapshot = { espacioId: space, listas: [], elementos: [] };
  } else {
    snapshot.espacioId = space;
  }
  await writeSnapshot(snapshot);
  spaceId = space;
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
  if (error) throw error;
  if (!data?.espacioId) throw new Error('No se pudo vincular este dispositivo.');
  history.replaceState(null, '', location.pathname);
  await showWorkspace(data.espacioId);
  showToast('Dispositivo vinculado.');
}

async function boot() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    snapshot = await readSnapshot();
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
        spaceId = snapshot.espacioId;
        updateSnapshot(snapshot);
        showHome();
        setStatus('offline', 'Sin conexión');
        return;
      }
      showSetup(error.message);
      setStatus(navigator.onLine ? 'error' : 'offline', navigator.onLine ? 'Error de sincronización' : 'Sin conexión');
      return;
    }

    currentUser = session.user;
    if (!navigator.onLine && snapshot.espacioId) {
      spaceId = snapshot.espacioId;
      showHome();
      setStatus('offline', 'Sin conexión');
      return;
    }

    let device;
    const { data, error } = await client
      .from('dispositivos')
      .select('espacio_id')
      .eq('auth_user_id', currentUser.id)
      .is('revocado_en', null)
      .maybeSingle();
    if (error) {
      showSetup(`No se pudo consultar el espacio: ${error.message}`);
      setStatus('error', 'Error de sincronización');
      return;
    }
    device = data;
    if (device) {
      await showWorkspace(device.espacio_id);
      return;
    }

    if (snapshot.espacioId) {
      await clearLocalData();
      snapshot = { espacioId: null, listas: [], elementos: [] };
    }

    const invitation = new URLSearchParams(location.search).get('invite');
    if (invitation) {
      document.getElementById('invite-code').value = invitation;
      try {
        await redeemInvitation(invitation);
        return;
      } catch (error) {
        showSetup(error.message);
        return;
      }
    }

    if (!navigator.onLine && snapshot.espacioId) {
      spaceId = snapshot.espacioId;
      updateSnapshot(snapshot);
      showHome();
      setStatus('offline', 'Sin conexión');
      return;
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

    synchronization?.stop();
    await clearLocalData();
    snapshot = { espacioId: null, listas: [], elementos: [] };
    spaceId = null;
    showSetup('El acceso de este dispositivo fue revocado. Puedes volver a vincularlo con una nueva invitación.');
    setStatus('error', 'Acceso revocado');
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

document.getElementById('items-list').addEventListener('change', async (event) => {
  const checkbox = event.target.closest('[data-item-action="toggle"]');
  if (!checkbox) return;
  try {
    await commit(() => updateItem(checkbox.dataset.itemId, { completado: checkbox.checked }));
  } catch (error) {
    showError(error);
  }
});
document.getElementById('items-list').addEventListener('click', async (event) => {
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
    const { data, error } = await client.functions.invoke('crear-invitacion', { body: {} });
    if (error) throw error;
    if (!data?.codigo) throw new Error('No se recibió el enlace de invitación.');
    const inviteUrl = new URL(location.href);
    inviteUrl.search = '';
    inviteUrl.hash = '';
    inviteUrl.searchParams.set('invite', data.codigo);
    document.getElementById('invite-link').value = inviteUrl.toString();
    document.getElementById('invite-result').hidden = false;
  } catch (error) {
    const label = document.getElementById('devices-error');
    label.textContent = error.message || 'No se pudo crear el enlace.';
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
    await ensureSession();
    const { data, error } = await client.functions.invoke('crear-espacio', { body: {} });
    if (error) throw error;
    if (!data?.espacioId) throw new Error('No se recibió el espacio compartido.');
    await showWorkspace(data.espacioId);
    showToast('Espacio creado. Comparte una invitación para vincular a otra persona.');
  } catch (error) {
    showSetup(error.message || 'No se pudo crear el espacio.');
  } finally {
    button.disabled = false;
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
