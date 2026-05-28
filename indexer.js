const fs = require('fs-extra');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const JSZip = require('jszip');
const zlib = require('zlib');
const crypto = require('crypto');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const os = require('os');

// Load configuration from app.js (single source of truth)
const appJsContent = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const DATABASE_DIR_NAME = appJsContent.match(/const\s+DATABASE_DIR_NAME\s*=\s*'([^']+)'/)?.[1] || 'database';
const COMPRESSED_SEARCH_INDEXES = appJsContent.match(/const\s+COMPRESSED_SEARCH_INDEXES\s*=\s*(true|false)/)?.[1] !== 'false';

// Calculate SHA-256 hash of parser and indexer logic to detect updates
const indexerCode = fs.readFileSync(__filename, 'utf8');
const codeHash = crypto.createHash('sha256').update(indexerCode + appJsContent).digest('hex');
const forceFlag = process.argv.includes('--force');

// Configuration
const DB_DIR = path.join(__dirname, DATABASE_DIR_NAME);
const CHUNK_SIZE = 80; // Files per JSON chunk to prevent RangeError
const SUPPORTED_EXT = ['pdf', 'docx', 'pptx', 'xlsx', 'xls', 'txt', 'csv', 'rtf', 'odt', 'odp', 'ods', 'srt', 'vtt'];

async function run() {
  console.log('🚀 Starting Robust Deep Indexer...');

  // Clean up any leftover temp files from a previous crashed run
  const initialFiles = await fs.readdir(DB_DIR).catch(() => []);
  for (const file of initialFiles) {
    if (file.startsWith('search-index-temp-')) {
      await fs.remove(path.join(DB_DIR, file)).catch(() => {});
    }
  }

  const files = await getAllFiles(DB_DIR);
  // Sort files naturally/numerically (e.g. S29_202_2 before S29_202_100)
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  // Filter out internal database/index files silently so they are not included in counts or loops
  const targetFiles = files.filter(filePath => {
    const filename = path.basename(filePath);
    return !(filename === 'manifest.json' || filename === 'search-index-info.json' || filename === 'search-index-report.json' || filename.startsWith('search-index-') || filename === 'README.txt');
  });
  const total = targetFiles.length;
  
  // Load existing index info if it exists for smart-skipping
  const infoPath = path.join(DB_DIR, 'search-index-info.json');
  let oldInfo = null;
  let forceFullRebuild = forceFlag;
  try {
    if (await fs.pathExists(infoPath)) {
      oldInfo = await fs.readJson(infoPath);
      if (oldInfo.codeHash !== codeHash) {
        console.log('\n⚠️  [Cache Invalidation] Extraction/detection logic has been modified since the last run.');
        console.log('⚙️  Forcing a full rebuild to apply updated parsing logic to all files!');
        forceFullRebuild = true;
      } else {
        console.log('📦 Loaded existing search-index-info.json for smart-skipping.');
      }
    }
  } catch (err) {
    // Ignore error
  }

  let activeChunkNum = null;
  let activeChunkData = null;
  async function getExistingSections(relPath) {
    if (!oldInfo || !oldInfo.fileToChunk || !oldInfo.fileToChunk[relPath]) {
      return null;
    }
    const chunkNum = oldInfo.fileToChunk[relPath];
    if (activeChunkNum !== chunkNum) {
      activeChunkData = null; // Free memory of previous chunk
      activeChunkNum = chunkNum;
      
      const isCompressed = (oldInfo && typeof oldInfo.compressed !== 'undefined') ? oldInfo.compressed : COMPRESSED_SEARCH_INDEXES;
      const primaryExt = isCompressed ? '.json.gz' : '.json';
      const secondaryExt = isCompressed ? '.json' : '.json.gz';
      
      let chunkPath = path.join(DB_DIR, `search-index-${chunkNum}${primaryExt}`);
      let readCompressed = isCompressed;
      
      // Fallback: check if the other format exists instead
      if (!(await fs.pathExists(chunkPath))) {
        const altPath = path.join(DB_DIR, `search-index-${chunkNum}${secondaryExt}`);
        if (await fs.pathExists(altPath)) {
          chunkPath = altPath;
          readCompressed = !isCompressed;
        }
      }
      
      try {
        if (await fs.pathExists(chunkPath)) {
          if (readCompressed) {
            const buffer = await fs.readFile(chunkPath);
            const decompressed = zlib.gunzipSync(buffer);
            activeChunkData = JSON.parse(decompressed.toString('utf8'));
          } else {
            activeChunkData = await fs.readJson(chunkPath);
          }
        }
      } catch (err) {
        console.warn(`\n⚠️ Failed to load cached chunk ${chunkNum}:`, err.message);
        activeChunkData = null;
        activeChunkNum = null;
        return null;
      }
    }
    if (activeChunkData && activeChunkData[relPath]) {
      return activeChunkData[relPath].sections;
    }
    return null;
  }
  const chunkTimestamps = oldInfo?.chunkTimestamps || {};
  let chunkCount = 0;
  const fileToChunk = {};
  const indexedFiles = [];
  const corruptedFiles = [];
  const skippedFiles = [];
  const ignoredFiles = [];

  const numWorkers = Math.max(1, os.cpus().length - 1);
  console.log(`🧵 Spawning pool of ${numWorkers} parallel extraction workers...`);
  const workers = [];
  for (let w = 0; w < numWorkers; w++) {
    workers.push(new Worker(__filename));
  }

  const numChunks = Math.ceil(total / CHUNK_SIZE);
  console.log(`📦 Processing ${total} files in ${numChunks} chunks...`);

  let overallProcessed = 0;
  let dirtyChunksCount = 0;

  for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
    const chunkFiles = targetFiles.slice(chunkIdx * CHUNK_SIZE, (chunkIdx + 1) * CHUNK_SIZE);
    const filesToExtract = [];
    const cachedData = {};
    const chunkResults = {};
    
    // 1. Scan and resolve cache hits for this chunk (with live scanning progress display)
    for (let fileIdx = 0; fileIdx < chunkFiles.length; fileIdx++) {
      const filePath = chunkFiles[fileIdx];
      const relPath = path.relative(__dirname, filePath).replace(/\\/g, '/');
      const ext = path.extname(filePath).toLowerCase().slice(1);
      const filename = path.basename(filePath);

      const absoluteFileIdx = chunkIdx * CHUNK_SIZE + fileIdx;
      if (absoluteFileIdx % 100 === 0 || absoluteFileIdx === total - 1) {
        const msg = `🔍 Scanning cache: [${absoluteFileIdx + 1}/${total}] files checked...`;
        process.stdout.write('\r' + msg.padEnd(80, ' '));
      }

      if (!SUPPORTED_EXT.includes(ext)) {
        ignoredFiles.push({ path: relPath, reason: `Unsupported extension: .${ext}` });
        overallProcessed++;
        continue;
      }

      let sections = null;
      let isCached = false;

      if (!forceFullRebuild && oldInfo && oldInfo.fileToChunk && oldInfo.fileToChunk[relPath]) {
        try {
          const stats = await fs.stat(filePath);
          if (stats.mtimeMs < oldInfo.indexedAt) {
            const cachedSections = await getExistingSections(relPath);
            if (cachedSections && cachedSections.length > 0) {
              sections = cachedSections;
              isCached = true;
            }
          }
        } catch (e) {
          // Fall back
        }
      }

      if (isCached) {
        cachedData[relPath] = sections;
        indexedFiles.push(relPath);
        overallProcessed++;
      } else {
        filesToExtract.push({ filePath, relPath, ext, filename });
      }
    }

    // Print a newline when cache scanning is fully finished
    if (chunkIdx === numChunks - 1) {
      const msg = `🔍 Scanning cache: [${total}/${total}] files checked... Done.`;
      process.stdout.write('\r' + msg.padEnd(80, ' ') + '\n');
    }

    // 2. Extract cache misses for this chunk using workers in parallel
    if (filesToExtract.length > 0) {
      let nextTaskIndex = 0;
      let activeWorkersCountForChunk = numWorkers;
      let completedTasksForChunk = 0;

      await new Promise((resolve) => {
        const sendNextTask = (worker) => {
          if (nextTaskIndex < filesToExtract.length) {
            const task = filesToExtract[nextTaskIndex];
            const taskId = nextTaskIndex;
            nextTaskIndex++;
            worker.postMessage({ type: 'extract', id: taskId, filePath: task.filePath, ext: task.ext });
          } else {
            activeWorkersCountForChunk--;
            if (activeWorkersCountForChunk === 0) {
              resolve();
            }
          }
        };

        workers.forEach(worker => {
          worker.removeAllListeners('message');
          worker.removeAllListeners('error');

          worker.on('message', (msg) => {
            if (msg.type === 'success') {
              const relPath = path.relative(__dirname, msg.filePath).replace(/\\/g, '/');
              chunkResults[relPath] = msg.sections;
              indexedFiles.push(relPath);
              completedTasksForChunk++;
              overallProcessed++;
              const progressMsg = `📦 Chunk [${chunkIdx + 1}/${numChunks}] - Extracted [${completedTasksForChunk}/${filesToExtract.length}] - Overall: [${overallProcessed}/${total}] processed...`;
              process.stdout.write('\r' + progressMsg.padEnd(100, ' '));
            } else if (msg.type === 'error') {
              const relPath = path.relative(__dirname, msg.filePath).replace(/\\/g, '/');
              chunkResults[relPath] = [];
              corruptedFiles.push({ path: relPath, error: msg.error });
              completedTasksForChunk++;
              overallProcessed++;
              console.error(`\n❌ Error indexing ${relPath}: ${msg.error}`);
            }
            sendNextTask(worker);
          });

          worker.on('error', (err) => {
            console.error('Worker thread error:', err);
            activeWorkersCountForChunk--;
            if (activeWorkersCountForChunk === 0) {
              resolve();
            }
          });

          sendNextTask(worker);
        });
      });
    }

    // 3. Assemble and conditionally save the chunk immediately to disk to free memory (Option 3: Dirty-Chunk Writing)
    const currentChunk = {};
    for (const filePath of chunkFiles) {
      const relPath = path.relative(__dirname, filePath).replace(/\\/g, '/');
      const ext = path.extname(filePath).toLowerCase().slice(1);
      const filename = path.basename(filePath);

      if (!SUPPORTED_EXT.includes(ext)) continue;

      let sections = cachedData[relPath] || chunkResults[relPath];
      if (sections === undefined) {
        sections = [];
      }

      if (sections.length === 0 && !corruptedFiles.some(f => f.path === relPath)) {
        if (!skippedFiles.some(f => f.path === relPath)) {
          skippedFiles.push({ path: relPath, reason: 'Empty text / No content extracted' });
        }
      }

      currentChunk[relPath] = {
        fileInfo: { name: filename, serverPath: relPath },
        sections: sections
      };
      fileToChunk[relPath] = chunkIdx + 1;
    }

    // Detect if this chunk is "dirty" (requires writing/overwriting to disk)
    const suffix = COMPRESSED_SEARCH_INDEXES ? '.json.gz' : '.json';
    const chunkFileName = `search-index-${chunkIdx + 1}${suffix}`;
    const chunkPath = path.join(DB_DIR, chunkFileName);
    const chunkExists = await fs.pathExists(chunkPath);
    const isDirty = forceFullRebuild || filesToExtract.length > 0 || !chunkExists;

    if (isDirty) {
      await saveChunk(currentChunk, chunkIdx);
      dirtyChunksCount++;
      chunkTimestamps[chunkIdx + 1] = Date.now();
    } else {
      if (!chunkTimestamps[chunkIdx + 1]) {
        chunkTimestamps[chunkIdx + 1] = oldInfo?.indexedAt || Date.now();
      }
    }
    chunkCount++;
  }

  // 4. Terminate worker threads cleanly
  workers.forEach(worker => {
    worker.postMessage({ type: 'exit' });
  });

  console.log(`\n💾 Saved ${dirtyChunksCount} dirty index chunk(s), skipped ${numChunks - dirtyChunksCount} unchanged chunk(s) on disk.`);

  // Save index metadata for parallel loading
  const infoObj = {
    totalChunks: chunkCount,
    indexedAt: Date.now(),
    codeHash: codeHash,
    fileToChunk,
    compressed: COMPRESSED_SEARCH_INDEXES,
    chunkTimestamps
  };
  const infoStr = JSON.stringify(infoObj, null, 2);
  const infoLines = infoStr.split('\n');
  const formattedInfoLines = [];
  let lastDir = null;
  for (const line of infoLines) {
    const match = line.match(/"(database\/[^"]+)"\s*:/);
    if (match) {
      const fullPath = match[1];
      const currentDir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      if (lastDir !== null && currentDir !== lastDir) {
        formattedInfoLines.push('');
      }
      lastDir = currentDir;
    }
    formattedInfoLines.push(line);
  }
  await fs.writeFile(infoPath, formattedInfoLines.join('\n'), 'utf8');

  const successfullyIndexedCount = indexedFiles.filter(path => 
    !skippedFiles.some(f => f.path === path) &&
    !corruptedFiles.some(f => f.path === path) &&
    !ignoredFiles.some(f => f.path === path)
  ).length;

  // Save detailed indexing report
  const reportPath = path.join(DB_DIR, 'search-index-report.json');
  await fs.outputJson(reportPath, {
    summary: {
      totalFoundInDirectory: total,
      successfullyIndexed: successfullyIndexedCount,
      skippedEmpty: skippedFiles.length,
      corruptedFailed: corruptedFiles.length,
      ignoredUnsupported: ignoredFiles.length
    },
    corruptedFiles,
    skippedFiles,
    ignoredFiles
  }, { spaces: 2 });

  console.log(`\n\n============================================`);
  console.log(`✅ Indexing complete! Saved ${chunkCount} index chunks.`);
  console.log(`============================================`);
  console.log(`📊 INDEXING SUMMARY:`);
  console.log(`   - Successfully Indexed      : ${successfullyIndexedCount} file(s)`);
  console.log(`   - Ignored (Unsupported)     : ${ignoredFiles.length} file(s)`);
  console.log(`   - Skipped (Empty/No text)   : ${skippedFiles.length} file(s)`);
  console.log(`   - Corrupted/Failed          : ${corruptedFiles.length} file(s)`);
  console.log(`============================================`);
  
  if (corruptedFiles.length > 0) {
    console.log(`\n⚠️  CORRUPTED/FAILED FILES:`);
    corruptedFiles.forEach((f, idx) => {
      console.log(`   ${idx + 1}. ${f.path} (Error: ${f.error})`);
    });
  }

  if (skippedFiles.length > 0) {
    console.log(`\nℹ️  SKIPPED/EMPTY FILES:`);
    skippedFiles.forEach((f, idx) => {
      console.log(`   ${idx + 1}. ${f.path}`);
    });
  }

  if (ignoredFiles.length > 0) {
    console.log(`\n🚫 IGNORED/UNSUPPORTED FILES:`);
    ignoredFiles.forEach((f, idx) => {
      console.log(`   ${idx + 1}. ${f.path} (${f.reason})`);
    });
  }

  // Clean up any leftover old chunks from previous larger runs
  console.log('🔄 Finalizing search index files...');
  const allFilesInDb = await fs.readdir(DB_DIR);
  let deletedLeftovers = 0;
  for (const file of allFilesInDb) {
    const match = file.match(/^search-index-(\d+)(?:\.json|\.json\.gz)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx > chunkCount) {
        await fs.remove(path.join(DB_DIR, file));
        deletedLeftovers++;
      }
    }
  }
  if (deletedLeftovers > 0) {
    console.log(`🧹 Cleaned up ${deletedLeftovers} leftover chunk file(s) from a previous larger database run.`);
  }

  console.log(`\n📂 Full indexing report saved to: database/search-index-report.json`);
  console.log('✨ All done. Upload all search-index-*.json files to your server.');
}

async function saveChunk(data, index) {
  const suffix = COMPRESSED_SEARCH_INDEXES ? '.json.gz' : '.json';
  const fileName = `search-index-${index + 1}${suffix}`;
  const fullPath = path.join(DB_DIR, fileName);
  if (COMPRESSED_SEARCH_INDEXES) {
    const jsonStr = JSON.stringify(data);
    const compressed = zlib.gzipSync(jsonStr);
    await fs.outputFile(fullPath, compressed);
  } else {
    await fs.outputJson(fullPath, data, { spaces: 0 });
  }
}

async function getAllFiles(dir) {
  let results = [];
  const list = await fs.readdir(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = await fs.stat(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(await getAllFiles(filePath));
    } else {
      results.push(filePath);
    }
  }
  return results;
}

async function extractSections(filePath, ext) {
  const buffer = await fs.readFile(filePath);

  try {
    if (ext === 'pdf') return await extractPDF(buffer);
    if (ext === 'docx') {
      const res = await mammoth.extractRawText({ buffer });
      return chunkText(res.value, 2000, 'Section');
    }
    if (ext === 'xlsx' || ext === 'xls' || ext === 'ods') {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      return wb.SheetNames.map(n => ({
        location: `Sheet: ${n}`,
        text: XLSX.utils.sheet_to_csv(wb.Sheets[n]),
        type: 'table',
        data: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 })
      }));
    }
    if (ext === 'pptx' || ext === 'odp') {
      const zip = await JSZip.loadAsync(buffer);
      const s = [];
      if (ext === 'pptx') {
        let n = 1;
        while (true) {
          const sl = zip.file(`ppt/slides/slide${n}.xml`);
          if (!sl) break;
          s.push({ location: `Slide ${n}`, text: xmlToText(await sl.async('text')) });
          n++;
        }
      } else {
        const c = zip.file('content.xml');
        if (c) {
          const xml = await c.async('text');
          xml.split('<draw:page').slice(1).forEach((pg, i) => s.push({ location: `Slide ${i + 1}`, text: xmlToText(pg) }));
        }
      }
      return s;
    }
    if (ext === 'odt') {
      const zip = await JSZip.loadAsync(buffer);
      const c = zip.file('content.xml');
      if (c) return chunkText(xmlToText(await c.async('text')), 2000, 'Section');
      return [];
    }

    if (['csv', 'txt', 'srt', 'vtt', 'rtf'].includes(ext)) {
      let t = buffer.toString('utf-8');
      if (ext === 'rtf') t = t.replace(/\{\\[^}]*\}/g, '').replace(/\\[a-z]+\-?\d*\s?/gi, '').replace(/[{}\\]/g, '').replace(/\s+/g, ' ');
      if (ext === 'srt' || ext === 'vtt') {
        const blocks = t.trim().split(/\n\s*\n/);
        const rows = blocks.map(block => {
          const lines = block.split('\n').map(l => l.trim()).filter(l => l);
          if (lines.length < 2) return null;
          let time = "", text = "";
          if (ext === 'srt') { time = lines[1] || ""; text = lines.slice(2).join(' '); }
          else { if (lines[0].includes('-->')) { time = lines[0]; text = lines.slice(1).join(' '); } else if (lines[1]?.includes('-->')) { time = lines[1]; text = lines.slice(2).join(' '); } }
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
  } catch (e) {
    console.warn(`[Fallback] Structured extraction failed for ${path.basename(filePath)}: ${e.message}. Attempting raw text recovery.`);
  }

  // Fallback / Raw Text Recovery (for any failed file, falsely-extensioned text files, or unknown formats)
  let rawText = buffer.toString('utf-8');
  // Clean up binary garbage (control characters and invalid UTF-8 symbols) but PRESERVE all international Unicode languages:
  rawText = rawText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFD]/g, ' ').replace(/ {2,}/g, ' ').trim();
  
  if (rawText.length > 5) {
    return chunkText(rawText, 2000, 'Recovered Text');
  }
  
  throw new Error(`File is completely unreadable or empty.`);
}

// Helper to split merged address and name
function splitAddressAndName(text) {
  const tokens = text.split(/\s+/).filter(t => t.trim().length > 0);
  if (tokens.length < 2) return { address: text, name: "" };

  const isNameToken = (t) => !/[\d/]/.test(t);

  let splitIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    let allSubsequentAreName = true;
    for (let j = i; j < tokens.length; j++) {
      if (!isNameToken(tokens[j])) {
        allSubsequentAreName = false;
        break;
      }
    }
    if (allSubsequentAreName) {
      splitIdx = i;
      break;
    }
  }

  if (splitIdx > 0 && splitIdx < tokens.length) {
    const address = tokens.slice(0, splitIdx).join(" ");
    const name = tokens.slice(splitIdx).join(" ");
    return { address, name };
  }

  return { address: text, name: "" };
}

async function extractPDF(buffer) {
  const uint8Array = new Uint8Array(buffer);
  const loadingTask = pdfjs.getDocument({ data: uint8Array, useSystemFonts: true, disableFontFace: true });
  const pdf = await loadingTask.promise;
  const s = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const pg = await pdf.getPage(p);
    const tc = await pg.getTextContent();
    if (!tc.items.length) continue;
    const rows = [];
    tc.items.forEach(item => {
      let r = rows.find(row => Math.abs(row.y - item.transform[5]) < 10);
      if (!r) { r = { y: item.transform[5], items: [] }; rows.push(r); }
      r.items.push(item);
    });
    rows.sort((a, b) => b.y - a.y);
    const xStarts = tc.items.map(it => it.transform[4]).sort((a, b) => a - b);
    const groups = [];
    if (xStarts.length) {
      let cur = xStarts[0], cnt = 1;
      for (let i = 1; i < xStarts.length; i++) {
        if (xStarts[i] - cur < 4) cnt++; 
        else { groups.push({ x: cur, cnt }); cur = xStarts[i]; cnt = 1; }
      }
      groups.push({ x: cur, cnt });
    }
    const colStarts = groups.filter(g => g.cnt >= Math.min(2, Math.max(1, rows.length * 0.05))).map(g => g.x).sort((a, b) => a - b);
    const structuredRows = rows.map(r => {
      const rowCells = new Array(Math.max(1, colStarts.length)).fill("");
      r.items.sort((a, b) => a.transform[4] - b.transform[4]);
      let lastX = -1, lastCol = -1;
      r.items.forEach(it => {
        const x = it.transform[4];
        let colIdx = 0;
        for (let i = 0; i < colStarts.length; i++) { if (x >= colStarts[i] - 2) colIdx = i; else break; }
        if (lastX !== -1 && (x - lastX) < 4 && lastCol !== -1) colIdx = lastCol;
        rowCells[colIdx] += (rowCells[colIdx] ? " " : "") + it.str;
        lastX = x + (it.width || 0); lastCol = colIdx;
      });
      return rowCells;
    });

    // Post-process structuredRows to split merged Address & Elector Name
    let electorNameColIdx = -1;
    let houseNoColIdx = -1;
    for (let rIdx = 0; rIdx < Math.min(10, structuredRows.length); rIdx++) {
      const row = structuredRows[rIdx];
      for (let cIdx = 0; cIdx < row.length; cIdx++) {
        const cellText = (row[cIdx] || "").trim().toLowerCase();
        if ((cellText.includes("elector") || cellText.includes("name")) && !cellText.includes("relation")) {
          electorNameColIdx = cIdx;
        }
        if (cellText.includes("house") || cellText.includes("addr") || cellText.includes("section")) {
          houseNoColIdx = cIdx;
        }
      }
      if (electorNameColIdx !== -1 && houseNoColIdx !== -1) break;
    }

    structuredRows.forEach((row) => {
      const rowText = row.join(" ").toLowerCase();
      if (rowText.includes("elector") || rowText.includes("constituency") || rowText.includes("relation") || rowText.includes("epic")) {
        return; 
      }

      for (let cIdx = 0; cIdx < row.length; cIdx++) {
        let val = (row[cIdx] || "").trim();
        if (!val) continue;

        const splitResult = splitAddressAndName(val);
        if (splitResult.name) {
          row[cIdx] = splitResult.address;

          let targetCol = electorNameColIdx;
          if (targetCol === -1 || targetCol === cIdx) {
            for (let j = cIdx + 1; j < row.length; j++) {
              if ((row[j] || "").trim() === "") {
                targetCol = j;
                break;
              }
            }
          }
          if (targetCol !== -1 && targetCol !== cIdx) {
            row[targetCol] = row[targetCol] ? (row[targetCol] + " " + splitResult.name) : splitResult.name;
          } else {
            row.push(splitResult.name);
          }
        }
      }
    });

    s.push({ location: `Page ${p}`, text: structuredRows.map(r => r.join(" \t ")).join("\n"), type: 'table', data: structuredRows });
  }
  return s;
}

function chunkText(text, size, pfx, byLines = false) {
  const c = [];
  if (byLines) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += size) c.push({ location: `${pfx} ${i + 1}–${Math.min(i + size, lines.length)}`, text: lines.slice(i, i + size).join('\n') });
  } else {
    for (let i = 0; i < text.length; i += size) c.push({ location: `${pfx} ${Math.floor(i / size) + 1}`, text: text.slice(i, i + size) });
  }
  return c.length ? c : [{ location: pfx + ' 1', text }];
}

function xmlToText(xml) { return xml.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(); }

if (!isMainThread) {
  // Worker Thread task listener
  parentPort.on('message', async (task) => {
    if (task.type === 'exit') {
      process.exit(0);
    }
    if (task.type === 'extract') {
      try {
        const sections = await extractSections(task.filePath, task.ext);
        parentPort.postMessage({ type: 'success', filePath: task.filePath, sections });
      } catch (err) {
        parentPort.postMessage({ type: 'error', filePath: task.filePath, error: err.message });
      }
    }
  });
} else {
  run().catch(console.error);
}
