const state = {
  tasks: [],
  scanResults: new Map(),
  selected: new Set(),
  busy: false
};

const elements = {
  taskList: document.querySelector('#taskList'),
  resultList: document.querySelector('#resultList'),
  totalSize: document.querySelector('#totalSize'),
  selectedSize: document.querySelector('#selectedSize'),
  lastRemoved: document.querySelector('#lastRemoved'),
  scanTime: document.querySelector('#scanTime'),
  statusText: document.querySelector('#statusText'),
  scanButton: document.querySelector('#scanButton'),
  cleanButton: document.querySelector('#cleanButton')
};

window.addEventListener('DOMContentLoaded', async () => {
  setBusy(true, 'Loading cleanup tasks...');
  state.tasks = await window.cleaner.listTasks();
  state.tasks.forEach((task) => {
    if (task.defaultSelected) state.selected.add(task.id);
  });
  renderTasks();
  setBusy(false, 'Ready to scan cache locations.');
});

elements.scanButton.addEventListener('click', async () => {
  setBusy(true, 'Scanning cache locations...');
  clearResults();

  try {
    const report = await window.cleaner.scan();
    applyScan(report);
    elements.statusText.textContent = `Scan complete. ${formatBytes(report.totalBytes)} could be cleaned.`;
  } catch (error) {
    elements.statusText.textContent = `Scan failed: ${readableError(error)}`;
  } finally {
    setBusy(false);
  }
});

elements.cleanButton.addEventListener('click', async () => {
  const selectedIds = [...state.selected].filter((id) => (state.scanResults.get(id)?.bytes ?? 0) > 0);
  if (selectedIds.length === 0) return;

  setBusy(true, 'Cleaning selected items...');
  clearResults();

  try {
    const cleanup = await window.cleaner.clean(selectedIds);

    if (cleanup.cancelled) {
      elements.statusText.textContent = 'Cleaning cancelled.';
      return;
    }

    elements.lastRemoved.textContent = formatBytes(cleanup.removedBytes);
    renderCleanupResults(cleanup.results);
    elements.statusText.textContent = `Clean complete. Actually removed ${formatBytes(cleanup.removedBytes)}.`;

    const report = await window.cleaner.scan();
    applyScan(report);
  } catch (error) {
    elements.statusText.textContent = `Clean failed: ${readableError(error)}`;
  } finally {
    setBusy(false);
  }
});

function applyScan(report) {
  state.scanResults = new Map(report.results.map((item) => [item.id, item]));
  elements.totalSize.textContent = formatBytes(report.totalBytes);
  elements.scanTime.textContent = `Scanned ${formatDateTime(report.scannedAt)}`;
  renderTasks();
  updateSelectedSize();
}

function renderTasks() {
  elements.taskList.innerHTML = '';

  state.tasks.forEach((task) => {
    const result = state.scanResults.get(task.id);
    const row = document.createElement('label');
    row.className = 'task-row';
    row.htmlFor = `task-${task.id}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `task-${task.id}`;
    checkbox.checked = state.selected.has(task.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(task.id);
      else state.selected.delete(task.id);
      updateSelectedSize();
    });

    const name = document.createElement('span');
    name.className = 'task-name';
    name.textContent = task.label;

    const detail = document.createElement('span');
    detail.className = 'task-detail';
    detail.textContent = task.needsAdmin ? `${task.detail} · Admin` : task.detail;

    const size = document.createElement('strong');
    size.className = 'task-size';
    size.textContent = result ? formatBytes(result.bytes) : '--';

    const status = document.createElement('span');
    status.className = `status status-${result?.status ?? 'pending'}`;
    status.textContent = statusLabel(result?.status);

    const textWrap = document.createElement('span');
    textWrap.className = 'task-copy';
    textWrap.append(name, detail);

    row.append(checkbox, textWrap, status, size);
    elements.taskList.append(row);
  });

  updateSelectedSize();
}

function renderCleanupResults(results) {
  elements.resultList.innerHTML = '';

  results.forEach((result) => {
    const item = document.createElement('div');
    item.className = `result-item result-${result.status}`;

    const title = document.createElement('strong');
    title.textContent = result.label;

    const amount = document.createElement('span');
    amount.textContent = result.status === 'failed'
      ? result.error
      : `Removed ${formatBytes(result.removedBytes)}`;

    item.append(title, amount);
    elements.resultList.append(item);
  });
}

function updateSelectedSize() {
  const selectedTotal = [...state.selected].reduce((sum, id) => {
    return sum + (state.scanResults.get(id)?.bytes ?? 0);
  }, 0);

  elements.selectedSize.textContent = state.scanResults.size ? formatBytes(selectedTotal) : '--';
  elements.cleanButton.disabled = state.busy || selectedTotal === 0;
}

function clearResults() {
  elements.resultList.innerHTML = '';
}

function setBusy(isBusy, message) {
  state.busy = isBusy;
  elements.scanButton.disabled = isBusy;
  elements.cleanButton.disabled = isBusy || selectedScannedBytes() === 0;

  if (message) elements.statusText.textContent = message;
}

function selectedScannedBytes() {
  return [...state.selected].reduce((sum, id) => sum + (state.scanResults.get(id)?.bytes ?? 0), 0);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  const digits = value >= 10 || index === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value));
}

function statusLabel(status) {
  if (status === 'ok') return 'Scanned';
  if (status === 'unavailable') return 'Unavailable';
  return 'Pending';
}

function readableError(error) {
  return error?.message || String(error);
}
