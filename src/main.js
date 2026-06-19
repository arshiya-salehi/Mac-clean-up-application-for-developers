const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const ONE_KB = 1024;
const userCacheExclusions = [
  homePath('Library/Caches/Homebrew'),
  homePath('Library/Caches/Google/AndroidStudio'),
  homePath('Library/Caches/Google/AndroidStudioPreview')
];

const taskDefinitions = [
  {
    id: 'userCaches',
    label: 'User Caches',
    detail: '~/Library/Caches',
    defaultSelected: true,
    scanner: () => sizeOfPathExcluding(homePath('Library/Caches'), userCacheExclusions),
    cleaner: () => removeContentsExcluding(homePath('Library/Caches'), userCacheExclusions)
  },
  {
    id: 'systemCaches',
    label: 'System Caches',
    detail: '/Library/Caches',
    defaultSelected: false,
    needsAdmin: true,
    scanner: () => scanPaths(['/Library/Caches']),
    cleaner: cleanSystemCaches
  },
  {
    id: 'homebrew',
    label: 'Homebrew Cache',
    detail: 'brew cleanup + cache',
    defaultSelected: true,
    scanner: scanHomebrew,
    cleaner: cleanHomebrew
  },
  {
    id: 'npm',
    label: 'npm Cache',
    detail: 'npm cache clean --force',
    defaultSelected: true,
    scanner: scanNpm,
    cleaner: cleanNpm
  },
  {
    id: 'xcodeDerivedData',
    label: 'Xcode DerivedData',
    detail: '~/Library/Developer/Xcode/DerivedData',
    defaultSelected: true,
    scanner: () => scanPaths([homePath('Library/Developer/Xcode/DerivedData')]),
    cleaner: () => removeContents([homePath('Library/Developer/Xcode/DerivedData')])
  },
  {
    id: 'xcodeArchives',
    label: 'Xcode Archives',
    detail: '~/Library/Developer/Xcode/Archives',
    defaultSelected: false,
    scanner: () => scanPaths([homePath('Library/Developer/Xcode/Archives')]),
    cleaner: () => removeContents([homePath('Library/Developer/Xcode/Archives')])
  },
  {
    id: 'mobileBackups',
    label: 'iPhone/iPad Backups',
    detail: '~/Library/Application Support/MobileSync/Backup',
    defaultSelected: false,
    scanner: () => scanPaths([homePath('Library/Application Support/MobileSync/Backup')]),
    cleaner: () => removeContents([homePath('Library/Application Support/MobileSync/Backup')])
  },
  {
    id: 'docker',
    label: 'Docker Cleanup',
    detail: 'docker system prune -af',
    defaultSelected: false,
    scanner: scanDocker,
    cleaner: cleanDocker
  },
  {
    id: 'android',
    label: 'Android Studio Cache',
    detail: '~/.gradle/caches + ~/Library/Android/cache',
    defaultSelected: true,
    scanner: () => scanPaths([
      homePath('.gradle/caches'),
      homePath('Library/Android/cache'),
      homePath('Library/Caches/Google/AndroidStudioPreview'),
      homePath('Library/Caches/Google/AndroidStudio')
    ]),
    cleaner: () => removeContents([
      homePath('.gradle/caches'),
      homePath('Library/Android/cache'),
      homePath('Library/Caches/Google/AndroidStudioPreview'),
      homePath('Library/Caches/Google/AndroidStudio')
    ])
  }
];

const tasksById = new Map(taskDefinitions.map((task) => [task.id, task]));

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    title: 'Mac Cleaner Pro',
    backgroundColor: '#f7f8fb',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer/index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('tasks:list', () => {
  return taskDefinitions.map(({ id, label, detail, defaultSelected, needsAdmin }) => ({
    id,
    label,
    detail,
    defaultSelected,
    needsAdmin: Boolean(needsAdmin)
  }));
});

ipcMain.handle('tasks:scan', async () => {
  return scanAllTasks();
});

ipcMain.handle('tasks:clean', async (_event, selectedIds) => {
  const ids = sanitizeTaskIds(selectedIds);
  const systemTaskSelected = ids.includes('systemCaches');

  if (systemTaskSelected) {
    const response = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Clean System Caches'],
      defaultId: 0,
      cancelId: 0,
      title: 'Administrator access required',
      message: 'Cleaning /Library/Caches requires administrator approval.',
      detail: 'macOS will ask for your password before system cache files are removed.'
    });

    if (response.response !== 1) {
      return {
        cancelled: true,
        removedBytes: 0,
        results: [],
        scannedAt: new Date().toISOString()
      };
    }
  }

  const before = await scanAllTasks();
  const results = [];

  for (const id of ids) {
    const task = tasksById.get(id);
    const beforeBytes = before.results.find((item) => item.id === id)?.bytes ?? 0;

    try {
      await task.cleaner();
      const afterTask = await scanTask(task);
      results.push({
        id,
        label: task.label,
        beforeBytes,
        afterBytes: afterTask.bytes,
        removedBytes: Math.max(0, beforeBytes - afterTask.bytes),
        status: 'cleaned'
      });
    } catch (error) {
      results.push({
        id,
        label: task.label,
        beforeBytes,
        afterBytes: beforeBytes,
        removedBytes: 0,
        status: 'failed',
        error: readableError(error)
      });
    }
  }

  return {
    cancelled: false,
    removedBytes: results.reduce((sum, item) => sum + item.removedBytes, 0),
    results,
    scannedAt: new Date().toISOString()
  };
});

async function scanAllTasks() {
  const results = await Promise.all(taskDefinitions.map(scanTask));
  return {
    results,
    totalBytes: results.reduce((sum, item) => sum + item.bytes, 0),
    scannedAt: new Date().toISOString()
  };
}

async function scanTask(task) {
  try {
    const bytes = await task.scanner();
    return {
      id: task.id,
      label: task.label,
      detail: task.detail,
      bytes,
      status: 'ok',
      needsAdmin: Boolean(task.needsAdmin)
    };
  } catch (error) {
    return {
      id: task.id,
      label: task.label,
      detail: task.detail,
      bytes: 0,
      status: 'unavailable',
      error: readableError(error),
      needsAdmin: Boolean(task.needsAdmin)
    };
  }
}

function sanitizeTaskIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids)].filter((id) => tasksById.has(id));
}

function homePath(relativePath) {
  return path.join(os.homedir(), relativePath);
}

async function scanPaths(paths) {
  const sizes = await Promise.all(paths.map(sizeOfPath));
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function sizeOfPath(targetPath) {
  try {
    await fs.access(targetPath);
  } catch {
    return 0;
  }

  const { stdout } = await execFileAsync('/usr/bin/du', ['-sk', targetPath], {
    maxBuffer: 1024 * 1024 * 8
  });
  const kilobytes = Number.parseInt(stdout.trim().split(/\s+/)[0], 10);
  return Number.isFinite(kilobytes) ? kilobytes * ONE_KB : 0;
}

async function sizeOfPathExcluding(targetPath, excludedPaths) {
  const excluded = normalizePathSet(excludedPaths);
  return sizeOfPathRecursive(path.resolve(targetPath), excluded);
}

async function sizeOfPathRecursive(targetPath, excluded) {
  const resolvedPath = path.resolve(targetPath);
  if (excluded.has(resolvedPath)) return 0;

  let stat;
  try {
    stat = await fs.lstat(resolvedPath);
  } catch {
    return 0;
  }

  if (!stat.isDirectory()) {
    return Number.isFinite(stat.blocks) ? stat.blocks * 512 : stat.size;
  }

  let entries;
  try {
    entries = await fs.readdir(resolvedPath);
  } catch {
    return 0;
  }

  const sizes = await Promise.all(entries.map((entry) => {
    return sizeOfPathRecursive(path.join(resolvedPath, entry), excluded);
  }));

  return sizes.reduce((sum, size) => sum + size, 0);
}

async function removeContents(paths) {
  for (const targetPath of paths) {
    let entries;

    try {
      entries = await fs.readdir(targetPath);
    } catch {
      continue;
    }

    await Promise.all(entries.map((entry) => {
      return fs.rm(path.join(targetPath, entry), {
        recursive: true,
        force: true,
        maxRetries: 2
      });
    }));
  }
}

async function removeContentsExcluding(targetPath, excludedPaths) {
  const excluded = normalizePathSet(excludedPaths);
  await removeChildrenExcluding(path.resolve(targetPath), excluded, true);
}

async function removeChildrenExcluding(targetPath, excluded, isRoot = false) {
  const resolvedPath = path.resolve(targetPath);
  if (excluded.has(resolvedPath)) return;

  let entries;
  try {
    entries = await fs.readdir(resolvedPath);
  } catch {
    return;
  }

  await Promise.all(entries.map(async (entry) => {
    const childPath = path.join(resolvedPath, entry);
    const resolvedChildPath = path.resolve(childPath);

    if (excluded.has(resolvedChildPath)) return;

    if (hasExcludedDescendant(resolvedChildPath, excluded)) {
      await removeChildrenExcluding(resolvedChildPath, excluded);
      return;
    }

    await fs.rm(childPath, {
      recursive: true,
      force: true,
      maxRetries: 2
    });
  }));

  if (!isRoot && !hasExcludedDescendant(resolvedPath, excluded)) {
    await fs.rmdir(resolvedPath).catch(() => {});
  }
}

function normalizePathSet(paths) {
  return new Set(paths.map((item) => path.resolve(item)));
}

function hasExcludedDescendant(targetPath, excluded) {
  const withSeparator = `${targetPath}${path.sep}`;
  return [...excluded].some((excludedPath) => excludedPath.startsWith(withSeparator));
}

async function scanHomebrew() {
  const cachePaths = new Set([
    homePath('Library/Caches/Homebrew')
  ]);

  try {
    const { stdout } = await execFileAsync('/opt/homebrew/bin/brew', ['--cache']);
    if (stdout.trim()) cachePaths.add(stdout.trim());
  } catch {
    try {
      const { stdout } = await execFileAsync('/usr/local/bin/brew', ['--cache']);
      if (stdout.trim()) cachePaths.add(stdout.trim());
    } catch {
      // Homebrew is optional.
    }
  }

  return scanPaths([...cachePaths]);
}

async function cleanHomebrew() {
  const brewPath = await resolveCommand(['/opt/homebrew/bin/brew', '/usr/local/bin/brew']);

  if (brewPath) {
    await execFileAsync(brewPath, ['cleanup', '-s'], { maxBuffer: 1024 * 1024 * 8 });
  }

  await removeContents([homePath('Library/Caches/Homebrew')]);
}

async function scanNpm() {
  const npmPath = await resolveCommand(['/opt/homebrew/bin/npm', '/usr/local/bin/npm', '/usr/bin/npm']);

  if (npmPath) {
    try {
      const { stdout } = await execFileAsync(npmPath, ['config', 'get', 'cache']);
      if (stdout.trim()) return sizeOfPath(stdout.trim());
    } catch {
      // Fall through to the common default.
    }
  }

  return sizeOfPath(homePath('.npm'));
}

async function cleanNpm() {
  const npmPath = await resolveCommand(['/opt/homebrew/bin/npm', '/usr/local/bin/npm', '/usr/bin/npm']);

  if (npmPath) {
    await execFileAsync(npmPath, ['cache', 'clean', '--force'], { maxBuffer: 1024 * 1024 * 8 });
    return;
  }

  await removeContents([homePath('.npm')]);
}

async function scanDocker() {
  const dockerPath = await resolveCommand(['/usr/local/bin/docker', '/opt/homebrew/bin/docker']);
  if (!dockerPath) return 0;

  const { stdout } = await execFileAsync(dockerPath, ['system', 'df'], {
    maxBuffer: 1024 * 1024 * 8
  });

  return parseDockerReclaimable(stdout);
}

async function cleanDocker() {
  const dockerPath = await resolveCommand(['/usr/local/bin/docker', '/opt/homebrew/bin/docker']);
  if (!dockerPath) return;
  await execFileAsync(dockerPath, ['system', 'prune', '-af'], { maxBuffer: 1024 * 1024 * 16 });
}

function parseDockerReclaimable(output) {
  return output
    .split('\n')
    .map((line) => line.match(/([0-9.]+)\s*([KMGT]?B)\s*\([0-9]+%\)$/i))
    .filter(Boolean)
    .reduce((sum, match) => sum + parseSize(match[1], match[2]), 0);
}

function parseSize(value, unit) {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return 0;

  const multipliers = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4
  };

  return Math.round(amount * (multipliers[unit.toUpperCase()] ?? 1));
}

async function cleanSystemCaches() {
  const script = [
    'do shell script "find /Library/Caches -mindepth 1 -maxdepth 1 -exec rm -rf {} +" with administrator privileges'
  ].join('\n');

  await execFileAsync('/usr/bin/osascript', ['-e', script], {
    maxBuffer: 1024 * 1024
  });
}

async function resolveCommand(candidates) {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Keep looking.
    }
  }

  return null;
}

function readableError(error) {
  if (!error) return 'Unknown error';
  if (error.code === 'ENOENT') return 'Command or path not found';
  return error.message || String(error);
}
