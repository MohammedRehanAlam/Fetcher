/* FETCHER — app.js | UI elements use ?. so commenting them out never breaks functionality */
const SUPPORTED_EXT = ['pdf', 'docx', 'pptx', 'xlsx', 'xls', 'txt', 'csv', 'rtf', 'odt', 'odp', 'ods', 'srt', 'vtt'];
const HISTORY_KEY = 'fetcher_history';
const AUTO_LOAD_DB = true; // Set to true to automatically load the database on startup
const SNIPPET_RADIUS = 100;
const ENABLE_INDEXING = true;

if (typeof pdfjsLib !== 'undefined')
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── Cache Manager
const CacheManager = {
  CACHE_NAME: 'fetcher-index-cache-v1',
  async get(url) {
    try {
      const key = url.split('?')[0]; // Strip timestamp for cache key
      const cache = await caches.open(this.CACHE_NAME);
      const res = await cache.match(key);
      return res ? await res.json() : null;
    } catch { return null; }
  },
  async set(url, data) {
    try {
      const key = url.split('?')[0]; // Strip timestamp for cache key
      const cache = await caches.open(this.CACHE_NAME);
      await cache.put(key, new Response(JSON.stringify(data)));
    } catch (e) { console.warn('Cache set failed:', e); }
  },
  async clear() { try { await caches.delete(this.CACHE_NAME); } catch {} }
};

// ── State
let databaseTree = null, selectedPath = [], cancelSearch = false, searchRunning = false;
let documentIndex = new Map(), isIndexed = false, selectedTypes = new Set(), searchMode = 'AND';
let currentMethod = null; // 'Browse Folder' or 'Pre-loaded Database'
let indexingMode = 'turbo'; // 'standard' or 'turbo'
let lastSelectedPath = null; // Track path to smartly clear memory

// ── DOM (all optional — safe if element is commented out)
const $ = id => document.getElementById(id);
const browseBtn = $('browse-btn');
const folderInput = $('folder-input');
const preloadBtn = $('preload-btn');
const manifestError = $('manifest-error');
const dbInfo = $('db-info');
const dropdownsCont = $('dropdowns-container');
const scopeSummary = $('scope-summary');
const typeFilterSection = $('type-filter-section');
const typeFilterChips = $('type-filter-chips');
const stepScope = $('step-scope');
const stepSearch = $('step-search');
const searchInput = $('search-input');
const findBtn = $('find-btn');
const histDD = $('history-dropdown');
const progressSect = $('progress-section');
const progressFill = $('progress-fill');
const progressText = $('progress-text');
const progressDetail = $('progress-detail');
const cancelBtn = $('cancel-btn');
const resultsSect = $('results-section');
const resultsCont = $('results-container');
const resultsCount = $('results-count');
const clearBtn = $('clear-btn');
const statusDot = $('status-dot');
const statusLabel = $('status-label');
// Index section (may be commented out)
const indexSection = $('index-section');
const indexFill = $('index-fill');
const indexText = $('index-text');
const indexStatus = $('index-status');
const indexDetail = $('index-detail');

// Collapsible Database Card
const stepLoad = $('step-load');
const dbToggleBtn = $('db-toggle-btn');
const dbCollapsedView = $('db-collapsed-view');
const dbCollapsedIcon = $('db-collapsed-icon');
const dbCollapsedName = $('db-collapsed-name');

dbToggleBtn?.addEventListener('click', () => {
  const isCollapsed = stepLoad?.classList.toggle('collapsed');
  dbCollapsedView?.classList.toggle('hidden', !isCollapsed);
});

dbCollapsedView?.addEventListener('click', () => {
  stepLoad?.classList.remove('collapsed');
  dbCollapsedView?.classList.add('hidden');
});

// ── Search History - storing a total of 20 items (only last 5 displayed) ──
const getHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } };
const addHistory = q => { let h = getHistory().filter(x => x !== q); h.unshift(q); localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 20))); };

function renderHistory() {
  if (!histDD) return;
  const h = getHistory();
  if (!h.length) { histDD.classList.add('hidden'); return; }
  
  // Show only last 5 items
  const displayH = h.slice(0, 5);
  
  histDD.innerHTML = displayH.map((q, i) => `
    <div class="hist-item" data-q="${escapeHtml(q)}">
      <span class="hist-icon">🕐</span>
      <span class="hist-text">${escapeHtml(q)}</span>
      <button class="hist-remove" data-q="${escapeHtml(q)}" title="Remove from history">✕</button>
    </div>`).join('')
    + `<div class="hist-clear" id="hclear">Clear All History</div>`;
    
  histDD.classList.remove('hidden');

  histDD.querySelectorAll('.hist-item').forEach(el => {
    el.addEventListener('click', (e) => {
      // Don't trigger search if the remove button was clicked
      if (e.target.classList.contains('hist-remove')) return;
      if (searchInput) searchInput.value = el.dataset.q;
      histDD.classList.add('hidden');
      startSearch();
    });
  });

  histDD.querySelectorAll('.hist-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const queryToRemove = btn.dataset.q;
      const updatedHistory = getHistory().filter(x => x !== queryToRemove);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
      renderHistory();
    });
  });

  const hc = $('hclear'); 
  if (hc) hc.addEventListener('click', () => { 
    localStorage.removeItem(HISTORY_KEY); 
    histDD.classList.add('hidden'); 
  });
}
searchInput?.addEventListener('focus', renderHistory);
document.addEventListener('click', e => { if (!e.target.closest('#search-input-wrap')) histDD?.classList.add('hidden'); });

// ── Method 1: Browse Folder
browseBtn?.addEventListener('click', () => { if (folderInput) { folderInput.value = ''; folderInput.click(); } });
folderInput?.addEventListener('change', async () => {
  resetAppUI();
  const files = Array.from(folderInput.files).filter(f => SUPPORTED_EXT.includes(getExt(f.name)));
  if (!files.length) { alert('No supported documents found.'); return; }
  databaseTree = buildTreeFromFiles(files); selectedPath = [];
  currentMethod = 'Browse Folder';
  await onDatabaseLoaded('Browse Folder');
});

function buildTreeFromFiles(files) {
  const rootName = files[0].webkitRelativePath.split('/')[0] || 'Selected Folder';
  const root = { name: rootName, children: [], files: [] };
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/');
    let node = root;
    for (let i = 1; i < parts.length - 1; i++) { let c = node.children.find(x => x.name === parts[i]); if (!c) { c = { name: parts[i], children: [], files: [] }; node.children.push(c); } node = c; }
    node.files.push({ name: file.name, fileObj: file });
  }
  sortTree(root); return root;
}

// ── Method 2: Pre-loaded
async function loadPreloadedDatabase(isAuto = false) {
  resetAppUI();
  manifestError?.classList.add('hidden');
  if (preloadBtn) { preloadBtn.textContent = 'Loading...'; preloadBtn.disabled = true; }
  try {
    const res = await fetch('database/manifest.json?t=' + Date.now());
    if (!res.ok) throw new Error();
    const paths = await res.json();
    if (!Array.isArray(paths) || !paths.length) throw new Error();
    databaseTree = buildTreeFromPaths(paths); selectedPath = [];
    currentMethod = 'Pre-loaded Database';
    await onDatabaseLoaded('Pre-loaded Database');
  } catch { 
    if (!isAuto) manifestError?.classList.remove('hidden');
    else console.warn('Auto-load: database/manifest.json not found or empty.');
  }
  if (preloadBtn) { preloadBtn.textContent = 'Use Database Folder'; preloadBtn.disabled = false; }
}
preloadBtn?.addEventListener('click', () => loadPreloadedDatabase(false));

function buildTreeFromPaths(paths) {
  const root = { name: 'database', children: [], files: [] };
  for (const fp of paths) {
    const norm = fp.replace(/\\/g, '/');
    const rel = norm.startsWith('database/') ? norm.slice(9) : norm;
    const parts = rel.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) { let c = node.children.find(x => x.name === parts[i]); if (!c) { c = { name: parts[i], children: [], files: [] }; node.children.push(c); } node = c; }
    const fn = parts[parts.length - 1];
    if (SUPPORTED_EXT.includes(getExt(fn))) node.files.push({ name: fn, serverPath: norm });
  }
  sortTree(root); return root;
}

// ── After database loaded
async function onDatabaseLoaded(methodLabel) {
  const tf = countFiles(databaseTree), tfold = countFolders(databaseTree);
  if (dbInfo) {
    dbInfo.classList.remove('hidden');
    dbInfo.innerHTML = `<div class="db-info-item"><span class="db-info-label">📁 Folder:</span><span class="db-info-value">${escapeHtml(databaseTree.name)}</span></div>
      <div class="db-info-item"><span class="db-info-label">📄 Files:</span><span class="db-info-value">${tf}</span></div>
      <div class="db-info-item"><span class="db-info-label">🗂️ Sub-folders:</span><span class="db-info-value">${tfold}</span></div>
      <span class="db-info-method">via ${methodLabel}</span>`;
  }

  // Capture the indexing strategy from the global UI
  indexingMode = document.querySelector('input[name="index-mode"]:checked')?.value || 'turbo';
  console.log(`Loading database with strategy: ${indexingMode}`);

  // Show the global strategy section only if indexing is enabled
  if (ENABLE_INDEXING) {
    document.getElementById('indexing-strategy-section')?.classList.remove('hidden');
  } else {
    document.getElementById('indexing-strategy-section')?.classList.add('hidden');
  }

  // Automation: Search will trigger scoped indexing automatically if needed.
  isIndexed = false;
  setStatus('loaded', `file${tf !== 1 ? 's' : ''} loaded`);

  // ONLY COLLAPSE UI AFTER SUCCESSFUL LOAD
  if (dbToggleBtn) dbToggleBtn.classList.remove('hidden');
  if (dbCollapsedIcon) dbCollapsedIcon.textContent = methodLabel.includes('Browse') ? '📂' : '🗄️';
  if (dbCollapsedName) dbCollapsedName.textContent = methodLabel;
  stepLoad?.classList.add('collapsed');
  dbCollapsedView?.classList.remove('hidden');

  stepScope?.classList.add('enabled'); stepScope?.classList.remove('disabled-card');
  stepSearch?.classList.add('enabled'); stepSearch?.classList.remove('disabled-card');
  renderDropdowns();
  renderTypeFilters();
}

function resetAppUI() {
  resultsSect?.classList.add('hidden');
  if (resultsCont) resultsCont.innerHTML = '';
  dbInfo?.classList.add('hidden');
  typeFilterSection?.classList.add('hidden');
  scopeSummary?.classList.add('hidden');
  document.getElementById('index-section')?.classList.add('hidden');
  document.getElementById('indexing-strategy-section')?.classList.add('hidden');
  documentIndex.clear();
  isIndexed = false;
  currentMethod = null;
  lastSelectedPath = null;
  setStatus('none', 'No database loaded');
}

async function tryLoadPrecomputedIndex(scopeKeys) {
  isIndexed = false;
  try {
    // 1. Try to get metadata for parallel loading
    let totalChunks = 0;
    try {
      const infoRes = await fetch('database/search-index-info.json?t=' + Date.now());
      if (infoRes.ok) {
        const info = await infoRes.json();
        totalChunks = info.totalChunks;
      }
    } catch (e) { console.log('Metadata not found, falling back to serial discovery.'); }

    let loadedChunks = 0;
    indexSection?.classList.remove('hidden');
    if (indexFill) indexFill.style.width = '0%';
    if (indexText) indexText.textContent = 'Initializing index fetch...';

    if (totalChunks > 0) {
      // ── Parallel Loading (Stream-Merge for Memory Safety) ──
      if (statusLabel) statusLabel.textContent = `Loading index`;

      const fetchPromises = [];
      for (let i = 0; i < totalChunks; i++) {
        const fileName = i === 0 ? 'search-index.json' : `search-index-${i}.json`;
        const url = `database/${fileName}?t=` + Date.now();
        
        fetchPromises.push(
          (async () => {
            let data = await CacheManager.get(url);
            if (!data) {
              const res = await fetch(url);
              if (!res.ok) throw new Error(`Failed to load ${fileName}`);
              data = await res.json();
              await CacheManager.set(url, data);
            }
            
            // Memory Optimization: Merge immediately and discard unneeded entries
            Object.entries(data).forEach(([k, v]) => {
              if ((!scopeKeys || scopeKeys.has(k)) && !documentIndex.has(k)) {
                documentIndex.set(k, v);
              }
            });
            data = null; // Explicitly signal for Garbage Collection

            loadedChunks++;
            const pct = Math.round((loadedChunks / totalChunks) * 100);
            if (indexText) indexText.textContent = `Loading: ${loadedChunks}/${totalChunks} (${pct}%)`;
            if (indexFill) indexFill.style.width = `${pct}%`;
            if (statusLabel) statusLabel.textContent = `Loading (${pct}%)...`;
          })()
        );
      }
      await Promise.all(fetchPromises);
    } else {
      // ── Serial Loading (Discovery Fallback) ──
      let chunkIdx = 0;
      while (true) {
        const fileName = chunkIdx === 0 ? 'search-index.json' : `search-index-${chunkIdx}.json`;
        const url = `database/${fileName}?t=` + Date.now();
        let data = await CacheManager.get(url);
        if (!data) {
          const res = await fetch(url);
          if (!res.ok) break;
          data = await res.json();
          await CacheManager.set(url, data);
        }
        
        // Memory Optimization: Merge immediately
        Object.entries(data).forEach(([k, v]) => {
          if ((!scopeKeys || scopeKeys.has(k)) && !documentIndex.has(k)) {
            documentIndex.set(k, v);
          }
        });
        data = null;

        chunkIdx++;
        if (indexText) indexText.textContent = `Discovering chunk ${chunkIdx}...`;
        chunkIdx++;
        if (chunkIdx > 1000) break;
      }
    }

    // Guarantee that ALL scopeKeys are marked as indexed to prevent infinite re-indexing loops
    // if the precomputed chunks are outdated and missing some files.
    if (scopeKeys) {
      for (const k of scopeKeys) {
        if (!documentIndex.has(k)) {
          documentIndex.set(k, { fileInfo: { name: k.split('/').pop(), serverPath: k }, sections: [] });
        }
      }
    }

    if (documentIndex.size > 0) {
      isIndexed = true;
    } else {
      throw new Error('No index data found for this scope.');
    }
  } catch (e) { 
    console.log('Chunked index load failed:', e.message); 
    isIndexed = false;
    if (indexText) indexText.textContent = `❌ Load failed: ${e.message}`;
    if (indexStatus) indexStatus.textContent = 'Error';
    if (indexFill) indexFill.style.backgroundColor = '#ef4444';
  }
}

async function runIndexingForScope(filesToIndex, scopeKeys) {
  // TURBO MODE: only applies to Pre-loaded Database method
  if (indexingMode === 'turbo' && currentMethod === 'Pre-loaded Database') {
    setStatus('loading', 'Loading index…');
    await tryLoadPrecomputedIndex(scopeKeys);
    
    // Fallback: if precomputed index (Node.js) isn't found, build it on the fly
    // This allows the .bat method (manifest only) to still work perfectly.
    if (!isIndexed) {
      console.log('Pre-computed index not found, falling back to client-side indexing.');
      setStatus('indexing', 'Indexing…');
      await buildIndex(filesToIndex);
    } else {
      if (indexFill) indexFill.style.width = '100%';
      if (indexText) indexText.textContent = `✅ ${documentIndex.size} files loaded`;
      if (indexStatus) indexStatus.textContent = 'Ready';
      setStatus('loaded', `file${filesToIndex.length !== 1 ? 's' : ''} loaded`);
    }
  } 
  // STANDARD MODE (On-the-fly indexing via browser/.bat manifest)
  else {
    setStatus('indexing', 'Indexing…');
    await buildIndex(filesToIndex);
  }
  
  renderTypeFilters();
}

function isScopeIndexed(scopeKeys) {
  if (!isIndexed || documentIndex.size === 0) return false;
  // If we have any of the keys missing, it's not fully indexed for this scope
  for (const k of scopeKeys) {
    if (!documentIndex.has(k)) return false;
  }
  return true;
}


// ── Pre-indexing
async function buildIndex(allFiles) {
  isIndexed = false;
  const filesToIndex = allFiles.filter(f => !documentIndex.has(fileKey(f)));

  if (filesToIndex.length === 0) {
    isIndexed = true;
    setStatus('loaded', `file${allFiles.length !== 1 ? 's' : ''} loaded`);
    return;
  }

  indexSection?.classList.remove('hidden');
  if (indexFill) indexFill.style.width = '0%';
  if (indexStatus) indexStatus.textContent = 'Processing...';

  // Parallel Concurrency: 10 files at a time (Safe for mobile, fast for loading)
  const CONCURRENCY = 10;
  let completed = 0;

  async function processFile(f) {
    try {
      const sections = await extractSections(f);
      documentIndex.set(fileKey(f), { fileInfo: f, sections });
    } catch (e) {
      console.warn('Index skip:', f.name, e.message);
      documentIndex.set(fileKey(f), { fileInfo: f, sections: [] });
    }
    completed++;
    const pct = Math.round((completed / filesToIndex.length) * 100);
    if (indexText) indexText.textContent = `Indexing: ${completed}/${filesToIndex.length} (${pct}%)`;
    if (indexDetail) indexDetail.textContent = `${getFileIcon(getExt(f.name))} ${f.name}`;
    if (indexFill) indexFill.style.width = `${pct}%`;
    if (statusLabel) statusLabel.textContent = `Loading index (${pct}%)`;
  }

  // Process in parallel batches
  for (let i = 0; i < filesToIndex.length; i += CONCURRENCY) {
    const batch = filesToIndex.slice(i, i + CONCURRENCY).map(f => processFile(f));
    await Promise.all(batch);
  }

  if (indexFill) indexFill.style.width = '100%';
  if (indexText) indexText.textContent = `✅ ${documentIndex.size} files indexed`;
  if (indexStatus) indexStatus.textContent = 'Ready';
  if (indexDetail) indexDetail.textContent = '';
  isIndexed = true;
  setStatus('loaded', `file${allFiles.length !== 1 ? 's' : ''} loaded`);
}
const fileKey = f => {
  if (f.serverPath) return f.serverPath;
  if (f.fileObj) return `local://${f.fileObj.webkitRelativePath || f.fileObj.name}-${f.fileObj.size}-${f.fileObj.lastModified}`;
  return f.name;
};

// ── File Type Filter
function renderTypeFilters() {
  if (!typeFilterSection || !typeFilterChips) return;
  const present = new Set();
  if (isIndexed) {
    for (const [, { fileInfo }] of documentIndex) present.add(getExt(fileInfo.name));
  } else if (databaseTree) {
    getAllFiles(databaseTree).forEach(f => present.add(getExt(f.name)));
  }
  if (present.size <= 1) { typeFilterSection.classList.add('hidden'); selectedTypes = new Set(present); return; }
  typeFilterSection.classList.remove('hidden');
  typeFilterChips.innerHTML = '';
  selectedTypes = new Set(present);
  for (const ext of [...present].sort()) {
    const chip = document.createElement('div'); chip.className = 'type-chip checked';
    chip.innerHTML = `${getFileIcon(ext)} ${ext.toUpperCase()}`;
    chip.addEventListener('click', () => {
      if (selectedTypes.has(ext)) { selectedTypes.delete(ext); chip.classList.remove('checked'); }
      else { selectedTypes.add(ext); chip.classList.add('checked'); }
    });
    typeFilterChips.appendChild(chip);
  }
}

// ── Tree utils
const getExt = name => name.split('.').pop().toLowerCase();
function sortTree(n) { n.children.sort((a, b) => a.name.localeCompare(b.name)); n.files.sort((a, b) => a.name.localeCompare(b.name)); n.children.forEach(sortTree); }
function countFiles(n) { return n.files.length + n.children.reduce((s, c) => s + countFiles(c), 0); }
function countFolders(n) { return n.children.length + n.children.reduce((s, c) => s + countFolders(c), 0); }
function getNodeAtPath(path) { let n = databaseTree; for (const nm of path) { const c = n.children.find(x => x.name === nm); if (!c) return null; n = c; } return n; }
function getAllFiles(node, parts = []) {
  const r = []; for (const f of node.files) r.push({ ...f, folderPath: parts.join(' / ') || databaseTree.name });
  for (const c of node.children) r.push(...getAllFiles(c, [...parts, c.name])); return r;
}

// ── Cascading dropdowns
function renderDropdowns() {
  if (!dropdownsCont) return; // UI hidden — scope defaults to full database
  dropdownsCont.innerHTML = '';
  let node = databaseTree, pathSoFar = [];
  for (let lv = 0; ; lv++) {
    if (!node.children.length) break;
    dropdownsCont.appendChild(buildDD(lv, node, pathSoFar));
    if (lv < selectedPath.length) { const ch = node.children.find(c => c.name === selectedPath[lv]); if (ch) { node = ch; pathSoFar = [...pathSoFar, selectedPath[lv]]; } else { selectedPath = selectedPath.slice(0, lv); break; } } else break;
  }
  updateScopeSummary();
}
function buildDD(lv, pNode, path) {
  const g = document.createElement('div'); g.className = 'dropdown-group';
  const lb = document.createElement('label'); lb.className = 'dropdown-label'; lb.textContent = lv === 0 ? '📁 Database' : `📂 ${path[path.length - 1]}`;
  const sel = document.createElement('select'); sel.className = 'dropdown-select';
  const ao = document.createElement('option'); ao.value = '__all__'; ao.textContent = lv === 0 ? '📁 All Database' : `📂 All in "${path[path.length - 1]}"`; sel.appendChild(ao);
  for (const ch of pNode.children) { const o = document.createElement('option'); o.value = ch.name; const fc = countFiles(ch); o.textContent = `📂 ${ch.name}  (${fc} file${fc !== 1 ? 's' : ''})`; sel.appendChild(o); }
  if (lv < selectedPath.length) sel.value = selectedPath[lv];
  sel.addEventListener('change', () => { selectedPath = sel.value === '__all__' ? selectedPath.slice(0, lv) : [...selectedPath.slice(0, lv), sel.value]; renderDropdowns(); });
  g.appendChild(lb); g.appendChild(sel); return g;
}
function updateScopeSummary() {
  if (!scopeSummary) return;
  const node = selectedPath.length === 0 ? databaseTree : getNodeAtPath(selectedPath);
  if (!node) { scopeSummary.classList.add('hidden'); return; }
  const tot = countFiles(node), ps = selectedPath.length === 0 ? databaseTree.name : `${databaseTree.name} / ${selectedPath.join(' / ')}`;
  scopeSummary.classList.remove('hidden');
  scopeSummary.innerHTML = `Searching in: <strong>${ps}</strong> &mdash; <strong>${tot}</strong> file${tot !== 1 ? 's' : ''}`;
}

// ── Search
findBtn?.addEventListener('click', startSearch);
searchInput?.addEventListener('keydown', e => { if (e.key === 'Enter') startSearch(); });
cancelBtn?.addEventListener('click', () => { cancelSearch = true; });
clearBtn?.addEventListener('click', () => { resultsSect?.classList.add('hidden'); if (resultsCont) resultsCont.innerHTML = ''; });

// Listen for global indexing mode changes
document.querySelectorAll('input[name="index-mode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    indexingMode = radio.value;
    console.log(`Switched indexing strategy to: ${indexingMode}`);
    // Clear the index so the next search re-processes with the new strategy
    isIndexed = false;
    documentIndex.clear();
    document.getElementById('index-section')?.classList.add('hidden');
  });
});

function parseQuery(raw) {
  if (raw.includes(' AND ')) return { terms: raw.split(' AND ').map(t => t.trim()), mode: 'AND' };
  if (raw.includes(' OR ')) return { terms: raw.split(' OR ').map(t => t.trim()), mode: 'OR' };
  return { terms: [raw], mode: searchMode };
}

function isSameBranch(path1, path2) {
  if (!path1 || !path2) return true; 
  if (path1.length === 0 || path2.length === 0) return true;
  const minLen = Math.min(path1.length, path2.length);
  for (let i = 0; i < minLen; i++) {
    if (path1[i] !== path2[i]) return false; 
  }
  return true;
}

async function startSearch() {
  const raw = searchInput?.value.trim();
  if (!raw) { searchInput?.focus(); return; }
  if (!databaseTree) { alert('Please load a database first.'); return; }
  if (searchRunning) return;

  const { terms, mode } = parseQuery(raw);
  const caseSensitive = $('opt-case')?.checked || false;
  const wholeWord = $('opt-whole')?.checked || false;
  histDD?.classList.add('hidden');
  addHistory(raw);

  const targetNode = selectedPath.length === 0 ? databaseTree : getNodeAtPath(selectedPath);
  if (!targetNode) return;
  const scopeFiles = getAllFiles(targetNode);
  // If type filter UI is hidden, allow all types; otherwise respect chip selection
  const activeTypes = typeFilterSection ? selectedTypes : new Set(SUPPORTED_EXT);
  const scopeKeys = new Set(scopeFiles.map(fileKey));

  cancelSearch = false; searchRunning = true;
  if (findBtn) findBtn.disabled = true;

  // Branch tracking to clear memory if switching completely (e.g. sibling folders)
  if (lastSelectedPath !== null && !isSameBranch(lastSelectedPath, selectedPath)) {
    if (!isScopeIndexed(scopeKeys)) {
      console.log('Switched to a different branch. Clearing memory to save RAM.');
      documentIndex.clear();
      isIndexed = false;
    } else {
      console.log('Switched to a different branch, but it is already fully indexed. Retaining memory.');
    }
  }
  lastSelectedPath = [...selectedPath];

  // AUTO-INDEX CHECK: If scope not indexed, do it now
  if (ENABLE_INDEXING && !isScopeIndexed(scopeKeys)) {
    await runIndexingForScope(scopeFiles, scopeKeys);
  }

  progressSect?.classList.remove('hidden');
  resultsSect?.classList.add('hidden');
  if (resultsCont) resultsCont.innerHTML = '';
  setStatus('searching', 'Searching…');

  const results = [];
  let totalOccurrences = 0;

  // Initialize UI for streaming
  resultsSect?.classList.remove('hidden');
  if (resultsCont) resultsCont.innerHTML = '';
  if (resultsCount) resultsCount.textContent = 'Searching...';

  if (isIndexed) {
    let processed = 0, total = 0;
    for (const [k] of documentIndex) if (scopeKeys.has(k)) total++;
    for (const [k, { fileInfo, sections }] of documentIndex) {
      if (!scopeKeys.has(k)) continue;
      if (!activeTypes.has(getExt(fileInfo.name))) continue;
      if (cancelSearch) break;
      processed++;
      if (progressText) progressText.textContent = `Searching ${processed} of ${total}…`;
      if (progressDetail) progressDetail.textContent = fileInfo.name;
      if (progressFill) progressFill.style.width = `${Math.round((processed / total) * 100)}%`;
      
      const groupedMatches = new Map();
      for (const sec of sections) {
        const occs = findAllOccurrences(sec.text, terms, mode, caseSensitive, wholeWord);
        if (occs.length > 0) {
          if (!groupedMatches.has(sec.location)) {
            groupedMatches.set(sec.location, {
              location: sec.location, text: sec.text,
              type: sec.type || 'text', data: sec.data || null,
              occurrences: occs
            });
          } else {
            const existing = groupedMatches.get(sec.location).occurrences;
            occs.forEach(o => { if (!existing.some(ex => ex.index === o.index)) existing.push(o); });
          }
        }
      }
      const matches = Array.from(groupedMatches.values());
      if (matches.length) {
        const res = { fileInfo, matches };
        results.push(res);
        totalOccurrences += matches.reduce((s, m) => s + (m.occurrences ? m.occurrences.length : 1), 0);
        appendResult(res, terms, results.length - 1, totalOccurrences);
      }
      await tick();
    }
  } else {
    for (let i = 0; i < scopeFiles.length; i++) {
      if (cancelSearch) break;
      const f = scopeFiles[i];
      if (!activeTypes.has(getExt(f.name))) continue;
      if (progressText) progressText.textContent = `Searching ${i + 1} of ${scopeFiles.length}…`;
      if (progressDetail) progressDetail.textContent = f.name;
      if (progressFill) progressFill.style.width = `${Math.round((i / scopeFiles.length) * 100)}%`;
      
      try { 
        const secs = await extractSections(f); 
        const groupedMatches = new Map(); 
        for (const sec of secs) {
          const occs = findAllOccurrences(sec.text, terms, mode, caseSensitive, wholeWord);
          if (occs.length > 0) {
            if (!groupedMatches.has(sec.location)) {
              groupedMatches.set(sec.location, {
                location: sec.location, text: sec.text,
                type: sec.type || 'text', data: sec.data || null,
                occurrences: occs
              });
            } else {
              const existing = groupedMatches.get(sec.location).occurrences;
              occs.forEach(o => { if (!existing.some(ex => ex.index === o.index)) existing.push(o); });
            }
          }
        }
        const matches = Array.from(groupedMatches.values());
        if (matches.length) {
          const res = { fileInfo: f, matches };
          results.push(res);
          totalOccurrences += matches.reduce((s, m) => s + (m.occurrences ? m.occurrences.length : 1), 0);
          appendResult(res, terms, results.length - 1, totalOccurrences);
        } 
      }
      catch (e) { console.warn('Skipped:', f.name); }
    }
  }

  if (progressFill) progressFill.style.width = '100%';
  finalizeResults(results, scopeFiles.length, cancelSearch);
  searchRunning = false;
  if (findBtn) findBtn.disabled = false;
  setStatus('loaded', `search complete`);
}

function appendResult(res, terms, index, totalOcc) {
  if (resultsCount) resultsCount.textContent = `${index + 1} file${index !== 0 ? 's' : ''} · ${totalOcc} occurrence${totalOcc !== 1 ? 's' : ''}`;
  resultsCont?.appendChild(buildCard(res, terms, index));
}

function finalizeResults(results, totalScanned, cancelled) {
  progressSect?.classList.add('hidden');
  if (cancelled && resultsCont) {
    resultsCont.insertAdjacentHTML('afterbegin', `<div class="warn-banner">⚠️ Search cancelled — partial results (${totalScanned} files scanned).</div>`);
  }
  if (results.length === 0) {
    if (resultsCont) resultsCont.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><h3>No matches found</h3><p>Try different keywords or broaden scope.</p></div>`;
    if (resultsCount) resultsCount.textContent = 'No matches';
  }
}

function matchTerms(text, terms, mode, cs, ww) {
  const cmp = cs ? text : text.toLowerCase();
  const check = t => {
    const ct = cs ? t : t.toLowerCase();
    const pattern = escapeRegex(ct)
      .replace(/\s+/g, '\\s+')
      .replace(/[‘’']/g, "['‘’]")
      .replace(/[“”"]/g, '["“”]')
      .replace(/[-–—]/g, "[-–—]");
    const startBound = (ww && /^[a-zA-Z0-9_]/.test(ct)) ? '\\b' : '';
    const endBound = (ww && /[a-zA-Z0-9_]$/.test(ct)) ? '\\b' : '';
    return new RegExp(`${startBound}${pattern}${endBound}`, cs ? '' : 'i').test(cmp);
  };
  return mode === 'AND' ? terms.every(check) : terms.some(check);
}

function findAllOccurrences(text, terms, mode, cs, ww) {
  const cmp = cs ? text : text.toLowerCase();
  const results = [];
  const findInText = (term) => {
    const ct = cs ? term : term.toLowerCase();
    const pattern = escapeRegex(ct)
      .replace(/\s+/g, '\\s+')
      .replace(/[‘’']/g, "['‘’]")
      .replace(/[“”"]/g, '["“”]')
      .replace(/[-–—]/g, "[-–—]");
    const startBound = (ww && /^[a-zA-Z0-9_]/.test(ct)) ? '\\b' : '';
    const endBound = (ww && /[a-zA-Z0-9_]$/.test(ct)) ? '\\b' : '';
    const regex = new RegExp(`${startBound}${pattern}${endBound}`, cs ? 'g' : 'gi');
    let m; while ((m = regex.exec(cmp)) !== null) results.push({ term, index: m.index });
  };
  if (mode === 'AND') {
    const allMatch = terms.every(t => {
      const ct = cs ? t : t.toLowerCase();
      const pattern = escapeRegex(ct)
        .replace(/\s+/g, '\\s+')
        .replace(/[‘’']/g, "['‘’]")
        .replace(/[“”"]/g, '["“”]')
        .replace(/[-–—]/g, "[-–—]");
      const startBound = (ww && /^[a-zA-Z0-9_]/.test(ct)) ? '\\b' : '';
      const endBound = (ww && /[a-zA-Z0-9_]$/.test(ct)) ? '\\b' : '';
      return new RegExp(`${startBound}${pattern}${endBound}`, cs ? '' : 'i').test(cmp);
    });
    if (allMatch) terms.forEach(findInText);
  } else {
    terms.forEach(findInText);
  }
  return results.sort((a, b) => a.index - b.index);
}
const tick = () => new Promise(r => setTimeout(r, 0));

// ── Text extraction
async function extractSections(f) {
  const key = `file-index-v1:${fileKey(f)}`;
  const cached = await CacheManager.get(key);
  if (cached) return cached;

  const ext = getExt(f.name);
  let res;
  try {
    if (ext === 'pdf') res = await extractPDF(f);
    else if (ext === 'docx') res = await extractDOCX(f);
    else if (ext === 'pptx' || ext === 'odp') res = await extractPPTX(f, ext);
    else if (['xlsx', 'xls', 'ods'].includes(ext)) res = await extractXLSX(f);
    else if (ext === 'odt') res = await extractODT(f);
    else res = await extractPlainText(f, ext);
  } catch (e) {
    console.warn(`[Fallback] Structured extraction failed for ${f.name}: ${e.message}. Attempting raw text recovery.`);
    try {
      const buffer = await getBuffer(f);
      let rawText = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
      rawText = rawText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFD]/g, ' ').replace(/ {2,}/g, ' ').trim();
      if (rawText.length > 5) {
        res = chunkText(rawText, 2000, 'Recovered Text');
      } else {
        throw new Error("Recovered text too short");
      }
    } catch (fallbackError) {
      throw new Error(`File is completely unreadable or empty.`);
    }
  }

  if (res) await CacheManager.set(key, res);
  return res;
}
async function getBuffer(f) { if (f.fileObj) return f.fileObj.arrayBuffer(); const r = await fetch(f.serverPath); if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }
async function getText(f) { if (f.fileObj) return f.fileObj.text(); const r = await fetch(f.serverPath); return r.text(); }
async function extractPDF(f) {
  const pdf = await pdfjsLib.getDocument({ data: await getBuffer(f) }).promise;
  const s = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const pg = await pdf.getPage(p);
    const tc = await pg.getTextContent();
    if (!tc.items.length) continue;
    
    // Group into rows by Y
    const rows = [];
    tc.items.forEach(item => {
      let r = rows.find(row => Math.abs(row.y - item.transform[5]) < 5);
      if (!r) { r = { y: item.transform[5], items: [] }; rows.push(r); }
      r.items.push(item);
    });
    rows.sort((a, b) => b.y - a.y);

    // Global Column Alignment: find common X-starts that occur across rows
    const xStarts = tc.items.map(it => it.transform[4]).sort((a, b) => a - b);
    const groups = [];
    if (xStarts.length) {
      let cur = xStarts[0], cnt = 1;
      for (let i = 1; i < xStarts.length; i++) {
        if (xStarts[i] - cur < 5) cnt++; 
        else { groups.push({ x: cur, cnt }); cur = xStarts[i]; cnt = 1; }
      }
      groups.push({ x: cur, cnt });
    }
    // More sensitive: Consider any X-start that appears at least twice or in 5% of rows
    const colStarts = groups.filter(g => g.cnt >= Math.min(2, Math.max(1, rows.length * 0.05))).map(g => g.x).sort((a, b) => a - b);

    // Assign each item to the nearest column start
    const structuredRows = rows.map(r => {
      const rowCells = new Array(Math.max(1, colStarts.length)).fill("");
      r.items.sort((a, b) => a.transform[4] - b.transform[4]);
      let lastX = -1, lastCol = -1;
      r.items.forEach(it => {
        const x = it.transform[4];
        let colIdx = 0;
        for (let i = 0; i < colStarts.length; i++) { if (x >= colStarts[i] - 2) colIdx = i; else break; }
        
        // Stricter force for same column (within 4 units)
        if (lastX !== -1 && (x - lastX) < 4 && lastCol !== -1) colIdx = lastCol;
        
        rowCells[colIdx] += (rowCells[colIdx] ? " " : "") + it.str;
        lastX = x + (it.width || 0); lastCol = colIdx;
      });
      return rowCells;
    });

    const isTable = colStarts.length >= 3 && structuredRows.filter(r => r.filter(c => c).length >= 3).length > rows.length * 0.15;
    if (isTable) s.push({ location: `Page ${p}`, text: structuredRows.map(r => r.join(" \t ")).join("\n"), type: 'table', data: structuredRows });
    else s.push({ location: `Page ${p}`, text: structuredRows.map(r => r.join(" ")).join("\n") });
  }
  
  // Free PDF memory
  try { pdf.destroy(); } catch(e) {}
  
  return s;
}
async function extractDOCX(f) { const r = await mammoth.extractRawText({ arrayBuffer: await getBuffer(f) }); return chunkText(r.value, 2000, 'Section'); }
async function extractPPTX(f, ext) { const zip = await JSZip.loadAsync(await getBuffer(f)); const s = []; if (ext === 'pptx') { let n = 1; while (true) { const sl = zip.file(`ppt/slides/slide${n}.xml`); if (!sl) break; s.push({ location: `Slide ${n}`, text: xmlToText(await sl.async('text')) }); n++; } } else { const c = zip.file('content.xml'); if (c) { const xml = await c.async('text'); xml.split('<draw:page').slice(1).forEach((pg, i) => s.push({ location: `Slide ${i + 1}`, text: xmlToText(pg) })); } } return s; }
async function extractXLSX(f) { const wb = XLSX.read(await getBuffer(f), { type: 'array' }); return wb.SheetNames.map(n => ({ location: `Sheet: ${n}`, text: XLSX.utils.sheet_to_csv(wb.Sheets[n]), type: 'table', data: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 }) })); }
async function extractODT(f) { const zip = await JSZip.loadAsync(await getBuffer(f)); const c = zip.file('content.xml'); if (!c) return []; return chunkText(xmlToText(await c.async('text')), 2000, 'Section'); }
async function extractPlainText(f, ext) {
  let t = await getText(f);
  if (ext === 'rtf') t = t.replace(/\{\\[^}]*\}/g, '').replace(/\\[a-z]+\-?\d*\s?/gi, '').replace(/[{}\\]/g, '').replace(/\s+/g, ' ');
  
  // Handle Subtitles/Transcripts (SRT/VTT)
  if (ext === 'srt' || ext === 'vtt') {
    const blocks = t.trim().split(/\n\s*\n/);
    const rows = blocks.map(block => {
      const lines = block.split('\n').map(l => l.trim()).filter(l => l);
      if (lines.length < 2) return null;
      let time = "", text = "";
      if (ext === 'srt') {
        time = lines[1] || "";
        text = lines.slice(2).join(' ');
      } else { // VTT
        if (lines[0].includes('-->')) { time = lines[0]; text = lines.slice(1).join(' '); }
        else if (lines[1]?.includes('-->')) { time = lines[1]; text = lines.slice(2).join(' '); }
      }
      return time ? [time, text] : null;
    }).filter(r => r);
    if (rows.length) return [{ location: 'Transcript', text: t, type: 'table', data: [['Time', 'Transcription'], ...rows] }];
  }

  if (ext === 'csv' || t.includes('\t') || (t.includes('  ') && t.split('\n')[0].split(/ {2,}|\t/).length > 2)) {
    const rows = t.split('\n').filter(l => l.trim()).map(line => line.split(ext === 'csv' ? ',' : / {2,}|\t/).map(c => c.trim()));
    return [{ location: 'Document', text: t, type: 'table', data: rows }];
  }
  return chunkText(t, 50, 'Lines', true);
}
function xmlToText(xml) { return xml.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(); }
function chunkText(text, size, pfx, byLines = false) { const c = []; if (byLines) { const lines = text.split('\n'); for (let i = 0; i < lines.length; i += size)c.push({ location: `${pfx} ${i + 1}–${Math.min(i + size, lines.length)}`, text: lines.slice(i, i + size).join('\n') }); } else { for (let i = 0; i < text.length; i += size)c.push({ location: `${pfx} ${Math.floor(i / size) + 1}`, text: text.slice(i, i + size) }); } return c.length ? c : [{ location: pfx + ' 1', text }]; }
function extractSnippet(text, query, cs, radius, forceIndex = -1) { const cmp = cs ? text : text.toLowerCase(), q = cs ? query : query.toLowerCase(); const idx = forceIndex !== -1 ? forceIndex : cmp.indexOf(q); if (idx === -1) return text.slice(0, radius * 2) + '…'; const s = Math.max(0, idx - radius), e = Math.min(text.length, idx + query.length + radius); return (s > 0 ? '…' : '') + text.slice(s, e) + (e < text.length ? '…' : ''); }
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Removed old showResults as it is now incremental via appendResult and finalizeResults
function buildCard({ fileInfo, matches }, terms, index) {
  const ext = getExt(fileInfo.name);
  const card = document.createElement('div'); card.className = 'result-card'; card.style.animationDelay = `${index * 50}ms`;
  const totalOccurrences = matches.reduce((s, m) => s + (m.occurrences ? m.occurrences.length : 1), 0);
  
  let folderPath = fileInfo.folderPath;
  if (!folderPath && fileInfo.serverPath) {
    const parts = fileInfo.serverPath.split('/');
    folderPath = parts.slice(0, -1).join(' / ') || 'Root';
  }
  if (!folderPath) folderPath = 'Selected Folder';

  card.innerHTML = `<div class="result-card-header"><div class="file-icon" style="background:${getFileColor(ext)};border:1px solid ${getFileBorder(ext)}">${getFileIcon(ext)}</div><div class="file-info"><div class="file-name" title="${escapeHtml(fileInfo.name)}">${escapeHtml(fileInfo.name)}</div><div class="file-path">📂 ${escapeHtml(folderPath)}</div></div><div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px"><span class="file-ext-badge ext-${ext}">${ext.toUpperCase()}</span><span class="file-match-count">${totalOccurrences} occurrence${totalOccurrences !== 1 ? 's' : ''}</span></div></div>`;
  const md = document.createElement('div'); md.className = 'result-matches';
  matches.forEach(m => {
    const it = document.createElement('div'); it.className = 'match-item';
    let contentHtml = "";
    if (m.type === 'table' && m.data) {
      const allRows = m.data;
      // Separate top text (titles) from table data
      let tableStart = allRows.findIndex(r => {
        const rowText = r.join(" ").toUpperCase();
        // Skip page headers like Constituency and PS NO so they stay in topRows metadata
        if (rowText.includes("CONSTITUENCY") || rowText.includes("PS NO:")) return false;
        return r.filter(c => c.trim()).length >= 3;
      });
      if (tableStart === -1) tableStart = 0;
      
      const topRows = allRows.slice(0, tableStart);
      const mainRows = allRows.slice(tableStart);
      
      const isHeader = mainRows[0]?.some(h => /name|id|no|age|gender|epic|date|total|amt|desc|type|status|addr|phone|email|sl|const|constituency|house|slno|sl.no/i.test(h))
                    || (mainRows.length > 1 && mainRows[0].every(c => isNaN(c.replace(/[$,]/g, ''))) && mainRows[1].some(c => !isNaN(c.replace(/[$,]/g, '')) && c.trim() !== ""));
      const headRow = isHeader ? mainRows[0] : null;
      const dataRows = isHeader ? mainRows.slice(1) : mainRows;
      
      const matchingRows = dataRows.filter(row => row.some(cell => matchTerms(String(cell), terms, 'OR', false, false)));
      const displayRows = matchingRows.length > 0 ? matchingRows : dataRows.slice(0, 5);

      // Prune empty columns and merge leading "title" columns
      // Prune empty columns based ONLY on row data
      const activeCols = [];
      const colCount = mainRows[0]?.length || 0;
      for (let c = 0; c < colCount; c++) {
        const hasData = displayRows.some(r => {
          const val = (r[c] || "").trim();
          return val.length > 1 || (val.length === 1 && /[a-zA-Z0-9]/.test(val));
        });
        if (hasData) activeCols.push(c);
      }
      
      let finalHead = headRow ? activeCols.map(i => headRow[i]) : null;
      
      // If we dropped columns that had headers, merge them into the first available column
      if (headRow && activeCols.length > 0) {
        let prefix = "";
        for (let c = 0; c < activeCols[0]; c++) {
          if (headRow[c]?.trim()) prefix += (prefix ? " " : "") + headRow[c].trim();
        }
        if (prefix) finalHead[0] = prefix + " " + (finalHead[0] || "");
      }

      const finalRows = displayRows.map(r => activeCols.map(i => r[i]));

      const topHtml = topRows.map(r => {
        let text = escapeHtml(r.join(" ").replace(/\s+/g, " ").trim());
        // Only inject the large gap specifically before "PS NO:"
        const formatted = text.replace(/(\bPS\s+NO:)/i, "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;$1");
        return `<div class="match-table-meta">${formatted}</div>`;
      }).join("");
      
      contentHtml = `${topHtml}<div class="match-table-wrapper"><table class="match-table">
        ${finalHead ? `<thead><tr>${finalHead.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>` : ''}
        <tbody>${finalRows.map(row => `<tr>${row.map(cell => `<td>${highlightAll(String(cell || ''), terms)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>${matchingRows.length > displayRows.length ? `<div class="match-table-more">+ ${matchingRows.length - displayRows.length} more matching rows</div>` : ''}</div>`;
    } else {
      const snippets = m.occurrences.map(occ => extractSnippet(m.text, occ.term, false, SNIPPET_RADIUS, occ.index));
      contentHtml = snippets.map(s => `<div class="match-snippet">${highlightAll(s, terms)}</div>`).join('');
    }
    it.innerHTML = `<div class="match-page-badge">${escapeHtml(m.location)}</div><div class="match-content">${contentHtml}</div>`;
    md.appendChild(it);
  });
  card.appendChild(md);
  const ft = document.createElement('div'); ft.className = 'result-card-footer';
  const ob = document.createElement('button'); ob.className = 'btn-open';
  ob.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg> Open File`;
  ob.addEventListener('click', async () => { try { const pg = matches[0]?.location?.match(/\d+/)?.[0] || 1; if (fileInfo.fileObj) { const url = URL.createObjectURL(fileInfo.fileObj); window.open(url + (ext === 'pdf' ? `#page=${pg}` : ''), '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000); } else if (fileInfo.serverPath) window.open(fileInfo.serverPath + (ext === 'pdf' ? `#page=${pg}` : ''), '_blank'); } catch (e) { alert('Cannot open: ' + e.message); } });
  ft.appendChild(ob); card.appendChild(ft); return card;
}
function isProbablyTable(text) { const lines = text.split('\n').filter(l => l.trim().length > 0); if (lines.length < 2) return false; return lines.filter(l => l.includes('    ') || l.includes('\t')).length > lines.length / 2; }
function parseTextTable(text) { return text.split('\n').filter(l => l.trim().length > 0).map(line => line.split(/ {2,}|\t/).map(cell => cell.trim())); }
function highlightAll(text, terms) {
  let h = escapeHtml(text);
  const ww = $('opt-whole')?.checked || false;
  for (const t of terms) {
    // Create a pattern that handles symbols both as literals and as HTML entities
    let pattern = escapeRegex(t)
      .replace(/\s+/g, '\\s+')
      .replace(/[‘’']/g, "(['‘’]|&apos;|&#39;)")
      .replace(/[“”"]/g, '(["“”]|&quot;|&#34;)')
      .replace(/[-–—]/g, "([-–—])");

    const startBound = (ww && /^[a-zA-Z0-9_]/.test(t)) ? '\\b' : '';
    const endBound = (ww && /[a-zA-Z0-9_]$/.test(t)) ? '\\b' : '';
    
    // We must match the potentially escaped versions in the HTML string
    h = h.replace(new RegExp(`(${startBound}${pattern}${endBound})`, 'gi'), '<mark>$1</mark>');
  }
  return h;
}
function getFileIcon(ext) { return { pdf: '📄', docx: '📝', doc: '📝', pptx: '📊', odp: '📊', xlsx: '📈', xls: '📈', ods: '📈', txt: '📋', csv: '🗂️', rtf: '📃', odt: '📝' }[ext] || '📄'; }
function getFileColor(ext) { if (['pdf'].includes(ext)) return 'rgba(239,68,68,0.15)'; if (['docx', 'doc', 'odt'].includes(ext)) return 'rgba(59,130,246,0.15)'; if (['pptx', 'odp'].includes(ext)) return 'rgba(245,158,11,0.15)'; if (['xlsx', 'xls', 'ods'].includes(ext)) return 'rgba(16,185,129,0.15)'; if (['csv'].includes(ext)) return 'rgba(6,182,212,0.15)'; return 'rgba(148,163,184,0.12)'; }
function getFileBorder(ext) { if (['pdf'].includes(ext)) return 'rgba(239,68,68,0.3)'; if (['docx', 'doc', 'odt'].includes(ext)) return 'rgba(59,130,246,0.3)'; if (['pptx', 'odp'].includes(ext)) return 'rgba(245,158,11,0.3)'; if (['xlsx', 'xls', 'ods'].includes(ext)) return 'rgba(16,185,129,0.3)'; if (['csv'].includes(ext)) return 'rgba(6,182,212,0.3)'; return 'rgba(148,163,184,0.25)'; }
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function setStatus(state, text) { if (statusDot) statusDot.className = `status-dot ${state}`; if (statusLabel) statusLabel.textContent = text; }

// ── Startup Auto-load ──
if (AUTO_LOAD_DB) {
  // Use a small delay to ensure all DOM listeners are ready
  setTimeout(() => loadPreloadedDatabase(true), 100);
}

// ── Footer Info Toggle ──
$('info-toggle-btn')?.addEventListener('click', () => {
  $('info-bar')?.classList.toggle('hidden');
});
