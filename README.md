# Fetcher — Intelligent Document Search Engine

A powerful, 100% local document search engine designed for high-volume information retrieval (perfect for SIR electoral data processing).

## 🚀 Key Features

- **Universal Format Support:** Search through **PDF, DOCX, PPTX, XLSX, TXT, CSV, RTF, ODT, ODP, ODS**.
- **Instant Search:** Automated pre-indexing caches document text in memory for lightning-fast results.
- **Smart Logic:** Supports **AND / OR** operators (e.g., `Rehan AND Hyderabad`).
- **Cascading Dropdowns:** Narrow your search scope to specific nested sub-folders.
- **Privacy First:** 100% local processing. No data ever leaves your device.
- **Search History:** Quickly rerun your last 20 searches.
- **Type Filtering:** Toggle specific file formats on or off.

## 🛠️ How to Use

### Method 1: Browse Folder (Most Private)
1. Open `index.html` in a modern browser (Chrome or Edge recommended).
2. Click **"Choose Database Folder"** and select any folder on your computer.
3. The app will automatically build a folder tree and index your files.

### Method 2: Pre-loaded Database (Persistent)
1. Place your documents inside the `database/` folder.
2. Run `generate-manifest.bat` once to index the file list.
3. Open `index.html` and click **"Use Database Folder"**.

### Method 3: High Performance (Pre-computed Index)
1. Best for the fastest experience with 4000+ files.
2. Ensure you have **Node.js** installed.
3. Run `npm install` and then `node indexer.js`.
4. This creates a `database/search-index.json` file.
5. The website will load this file automatically for **instant** searching.

## 📁 Recommended Structure for SIR Work
```
database/
├── State_Name/
│   ├── District_A/
│   │   ├── Constituency_1/
│   │   │   └── Part_001.pdf
│   │   └── Constituency_2/
│   │       └── Part_001.pdf
│   └── District_B/
│       └── Summary.xlsx
└── Global_List.csv
```

## ⚠️ Requirements
- **Browser:** Google Chrome or Microsoft Edge (versions 86+).
- **Setup:** For the "Pre-loaded" mode, Windows is required to run the `.bat` file.
- **Setup:** For the "High Performance" mode, **Node.js** is required.
- **Setup:** For the "Browse Folder" mode, **No Setup** is required.

---
*Fetcher © 2026 — Built for high-speed local document intelligence.*
