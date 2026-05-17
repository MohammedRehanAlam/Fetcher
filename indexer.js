const fs = require('fs-extra');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const JSZip = require('jszip');

// Configuration
const DB_DIR = path.join(__dirname, 'database');
const CHUNK_SIZE = 40; // Files per JSON chunk to prevent RangeError
const SUPPORTED_EXT = ['pdf', 'docx', 'pptx', 'xlsx', 'xls', 'txt', 'csv', 'rtf', 'odt', 'odp', 'ods', 'srt', 'vtt'];

async function run() {
  console.log('🚀 Starting Robust Deep Indexer...');
  const files = await getAllFiles(DB_DIR);
  const total = files.length;
  
  let currentChunk = {};
  let chunkCount = 0;
  let processedInChunk = 0;

  for (let i = 0; i < total; i++) {
    const filePath = files[i];
    const relPath = path.relative(__dirname, filePath).replace(/\\/g, '/');
    const ext = path.extname(filePath).toLowerCase().slice(1);
    
    if (!SUPPORTED_EXT.includes(ext)) continue;

    process.stdout.write(`\rIndexing [${i + 1}/${total}]: ${path.basename(filePath)}... `);

    try {
      const sections = await extractSections(filePath, ext);
      currentChunk[relPath] = {
        fileInfo: { name: path.basename(filePath), serverPath: relPath },
        sections: sections
      };
      processedInChunk++;

      // Save chunk and reset if limit reached
      if (processedInChunk >= CHUNK_SIZE) {
        await saveChunk(currentChunk, chunkCount);
        currentChunk = {};
        chunkCount++;
        processedInChunk = 0;
      }
    } catch (e) {
      console.error(`\n❌ Error indexing ${filePath}: ${e.message}`);
      currentChunk[relPath] = {
        fileInfo: { name: path.basename(filePath), serverPath: relPath },
        sections: []
      };
      processedInChunk++;
      if (processedInChunk >= CHUNK_SIZE) {
        await saveChunk(currentChunk, chunkCount);
        currentChunk = {};
        chunkCount++;
        processedInChunk = 0;
      }
    }
  }

  // Save final chunk
  if (Object.keys(currentChunk).length > 0) {
    await saveChunk(currentChunk, chunkCount);
    chunkCount++;
  }

  // Save index metadata for parallel loading
  const infoPath = path.join(DB_DIR, 'search-index-info.json');
  await fs.outputJson(infoPath, { totalChunks: chunkCount }, { spaces: 2 });

  console.log(`\n\n✅ Indexing complete! Saved ${chunkCount} index chunks.`);
  console.log('✨ All done. Upload all search-index-*.json files to your server.');
}

async function saveChunk(data, index) {
  const fileName = index === 0 ? 'search-index.json' : `search-index-${index}.json`;
  const fullPath = path.join(DB_DIR, fileName);
  await fs.outputJson(fullPath, data, { spaces: 0 });
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

run().catch(console.error);
