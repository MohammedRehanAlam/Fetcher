# Fetcher — Intelligent Document Search Engine

A powerful, 100% local document search engine optimized for mobile performance and high-volume information retrieval.

## 🚀 Key Features

- **Universal Format Support:** Search through **PDF, DOCX, PPTX, XLSX, TXT, CSV, RTF, ODT, ODP, ODS**.
- **Automated Scoped Indexing:** Indexing is triggered automatically when you search. It smartly only indexes the folder you have selected, preventing memory crashes on mobile devices.
- **Persistent Caching:** High-performance index chunks are stored in your browser's local cache. Subsequent loads are instantaneous.
- **Privacy First:** 100% local processing. No data ever leaves your device.
- **Premium UI:** Responsive dark-mode interface designed for both Desktop and Mobile.

## 🛠️ How to Use

### Method 1: Browse Folder (No Setup)
1. Open `index.html` and click **"Select Folder"**.
2. Pick any folder. The app will build a temporary tree and index files automatically when you search.

### Method 2: Pre-loaded Database (Standard)
1. Place documents inside the `database/` folder.
2. Run `generate-manifest.bat` once to create the file list.
3. Open `index.html` and click **"Use Database Folder"**.
4. The app will index your files automatically during your first search.

### Method 3: High Performance (Recommended for 1000+ files)
1. Follow Method 2, but also run `node indexer.js` (requires Node.js).
2. This creates pre-computed index chunks in the `database/` folder.
3. Searching will now be **near-instant**, as the browser doesn't have to build the index itself.

## 📱 Mobile Optimization
Fetcher is specifically tuned for mobile browsers:
- **Lazy Loading:** Data is only loaded into memory when required by the user's search scope.
- **Memory Management:** Automatically clears large buffers and handles PDF cleanup to prevent crashes.
- **Responsive Layout:** All cards and search tools adjust for small screens.

## ⚠️ Requirements
- **Browser:** Chrome, Edge, or Safari (iOS).
- **Setup:** For Method 2, Windows is required to run the `.bat` file.
- **Setup:** For Method 3, **Node.js** is required.

---
*Fetcher © 2026 — Built for high-speed local document intelligence.*
