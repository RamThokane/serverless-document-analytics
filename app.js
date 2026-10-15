/*
 * app.js — DocAnalytics frontend
 * ==============================
 *
 * How the frontend talks to AWS
 * -----------------------------
 * The browser NEVER talks to DynamoDB or Lambda directly and NEVER holds AWS
 * credentials. Everything goes through one API Gateway HTTP API (base URL in
 * config.js), backed by an "API Lambda":
 *
 *   1. Upload:
 *        Browser --POST /uploads--------------> API Gateway -> API Lambda
 *        Browser <--{ uploadUrl, documentId }-- (Lambda signs a short-lived S3 PUT URL
 *                                               for incoming/<id>.txt)
 *        Browser --PUT file--> S3 (presigned URL, no credentials needed)
 *        S3 event (incoming/*.txt) --> DocumentProcessor Lambda --> DynamoDB
 *
 *   2. Read results:
 *        Browser --GET /documents---------> API Lambda --Scan/Query--> DynamoDB
 *        Browser --GET /documents/{id}----> API Lambda --GetItem-----> DynamoDB
 *
 * File layout (top to bottom):
 *   1. Config & small utilities
 *   2. Api           — every network call lives here
 *   3. normalise*    — converts API JSON into one predictable shape
 *   4. validateFile  — client-side upload checks
 *   5. Ui            — toasts, loading/empty/error states
 *   6. Views         — overview, documents, details, upload, setup
 *   7. Router & startup
 *
 * There is deliberately NO mock data: if the API is not configured or fails,
 * the UI says so instead of showing invented numbers.
 */
(function () {
  "use strict";

  /* =========================================================
     1. Config & utilities
     ========================================================= */

  const CONFIG = window.APP_CONFIG || {};
  const API_BASE = String(CONFIG.apiBaseUrl || "").trim().replace(/\/+$/, "");
  const UPLOAD_RULES = CONFIG.upload || {};

  /** True only when a real HTTPS (or local http) API URL has been set in config.js. */
  function isApiConfigured() {
    return /^https?:\/\/[^\s]+$/i.test(API_BASE);
  }

  const $ = (selector) => document.querySelector(selector);

  /**
   * Tiny DOM builder. All text goes through textContent, so file names and
   * other API data can never inject HTML (prevents XSS).
   */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? "" : value);
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  /** Inline SVG icon from a path string (matches the icons in index.html). */
  function icon(pathData) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    svg.append(path);
    return svg;
  }
  const ICONS = {
    file: "M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6",
    alert: "M12 8v5M12 16.5v.5M10.3 4.2 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z",
    plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4",
    search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4"
  };

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function formatNumber(value) {
    return Number.isFinite(value) ? value.toLocaleString() : "—";
  }

  function formatDate(date) {
    if (!(date instanceof Date) || isNaN(date)) return "—";
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function fileExtension(name) {
    const dot = String(name || "").lastIndexOf(".");
    return dot >= 0 ? name.slice(dot).toLowerCase() : "";
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* =========================================================
     2. Api — the only place that performs network requests
     ========================================================= */

  /** Error type that keeps the HTTP status so callers can react (e.g. 404). */
  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = "ApiError";
      this.status = status || 0;
    }
  }

  const Api = {
    /**
     * Generic JSON request to API Gateway with a timeout.
     * Converts network failures, timeouts and non-2xx responses into ApiError
     * with a human-readable message.
     */
    async request(path, options = {}) {
      if (!isApiConfigured()) {
        throw new ApiError("The API base URL is not configured in config.js.", 0);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs || 15000);

      let response;
      try {
        response = await fetch(API_BASE + path, {
          method: options.method || "GET",
          headers: options.body ? { "Content-Type": "application/json" } : undefined,
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal
        });
      } catch (err) {
        if (err.name === "AbortError") throw new ApiError("The API did not respond in time.", 0);
        // fetch() rejects with TypeError for DNS/CORS/offline problems.
        throw new ApiError("Could not reach the API. Check your connection, the API URL and CORS settings.", 0);
      } finally {
        clearTimeout(timer);
      }

      let data = null;
      const text = await response.text();
      if (text) {
        try { data = JSON.parse(text); } catch { data = null; }
      }

      if (!response.ok) {
        const serverMessage = data && (data.message || data.error);
        throw new ApiError(serverMessage || `API request failed (HTTP ${response.status}).`, response.status);
      }
      return data;
    },

    /**
     * POST /uploads
     * Asks the API Lambda for a presigned S3 PUT URL. The Lambda decides the
     * object key (under incoming/) — the browser cannot choose arbitrary paths.
     * Expected response: { uploadUrl, documentId, key?, expiresIn? }
     */
    async requestUploadUrl(file) {
      const data = await this.request("/uploads", {
        method: "POST",
        body: {
          fileName: file.name,
          contentType: UPLOAD_RULES.contentType || "text/plain",
          fileSize: file.size
        }
      });
      if (!data || typeof data.uploadUrl !== "string" || !data.uploadUrl) {
        throw new ApiError("The API response did not include an upload URL.", 0);
      }
      return data;
    },

    /**
     * PUT the raw file to S3 using the presigned URL.
     * Uses XMLHttpRequest (not fetch) only because it reports upload progress.
     * The Content-Type header must match the one the URL was signed with.
     */
    uploadToS3(uploadUrl, file, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", UPLOAD_RULES.contentType || "text/plain");
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else if (xhr.status === 403) reject(new ApiError("S3 rejected the upload (403). The presigned URL may have expired or the Content-Type does not match.", 403));
          else reject(new ApiError(`S3 upload failed (HTTP ${xhr.status}).`, xhr.status));
        };
        xhr.onerror = () => reject(new ApiError("Network error while uploading to S3. Check the bucket's CORS configuration.", 0));
        xhr.ontimeout = () => reject(new ApiError("The upload to S3 timed out.", 0));
        xhr.send(file);
      });
    },

    /**
     * GET /documents
     * Accepts either a bare array or { items: [...] } / { documents: [...] }.
     */
    async listDocuments() {
      const data = await this.request("/documents");
      const items = Array.isArray(data) ? data : (data && (data.items || data.documents)) || [];
      return items.map(normaliseDocument).filter(Boolean);
    },

    /** GET /documents/{documentId} */
    async getDocument(documentId) {
      const data = await this.request("/documents/" + encodeURIComponent(documentId));
      const doc = normaliseDocument(data && (data.item || data.document || data));
      if (!doc) throw new ApiError("The API returned an unreadable document record.", 0);
      return doc;
    }
  };

  /* =========================================================
     3. Normalisation — map API/DynamoDB fields to one shape
     ========================================================= */

  /*
   * The exact attribute names depend on how DocumentProcessor writes to
   * DynamoDB and how the API Lambda returns them. This function accepts the
   * common variants so the UI does not break on naming differences, but it
   * never fills in values that are missing — missing numbers stay null and
   * are shown as "—".
   */

  const STATUS_MAP = {
    processed: "processed", completed: "processed", complete: "processed", success: "processed", succeeded: "processed", done: "processed",
    pending: "pending", processing: "pending", uploaded: "pending", queued: "pending", in_progress: "pending",
    failed: "failed", error: "failed"
  };

  const STATUS_LABELS = { processed: "Processed", pending: "Pending", failed: "Failed", unknown: "Unknown" };

  function pick(obj, keys) {
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
    }
    return undefined;
  }

  function toNumber(value) {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function toDate(value) {
    if (value === undefined || value === null || value === "") return null;
    // Numeric epoch: treat values below 1e12 as seconds, otherwise milliseconds.
    if (typeof value === "number" || /^\d+$/.test(String(value))) {
      const n = Number(value);
      return new Date(n < 1e12 ? n * 1000 : n);
    }
    const d = new Date(value);
    return isNaN(d) ? null : d;
  }

  /** Accepts [{word,count}], [[word,count]] or { word: count }. Returns sorted [{word,count}]. */
  function normaliseKeywords(raw) {
    if (!raw) return [];
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw); } catch { return []; }
    }
    let list = [];
    if (Array.isArray(raw)) {
      list = raw.map((entry) => {
        if (Array.isArray(entry)) return { word: String(entry[0]), count: toNumber(entry[1]) };
        if (entry && typeof entry === "object") {
          return {
            word: String(pick(entry, ["word", "keyword", "term", "text"]) ?? ""),
            count: toNumber(pick(entry, ["count", "frequency", "freq", "occurrences"]))
          };
        }
        return null;
      });
    } else if (typeof raw === "object") {
      list = Object.entries(raw).map(([word, count]) => ({ word, count: toNumber(count) }));
    }
    return list
      .filter((k) => k && k.word && k.count !== null)
      .sort((a, b) => b.count - a.count);
  }

  function normaliseDocument(raw) {
    if (!raw || typeof raw !== "object") return null;

    // The deployed API nests the processor's results under "analytics"
    // ({ analytics: { wordCount, characterCount, paragraphCount, topKeywords } }).
    // Lift them to the top level; top-level fields win if both exist.
    if (raw.analytics && typeof raw.analytics === "object" && !Array.isArray(raw.analytics)) {
      raw = { ...raw.analytics, ...raw };
    }

    const id = pick(raw, ["documentId", "document_id", "id", "docId", "objectKey", "s3Key", "key"]);
    if (id === undefined) return null;

    const key = pick(raw, ["s3Key", "objectKey", "key"]);
    const fileName = String(pick(raw, ["fileName", "filename", "originalFileName", "name"]) ||
      (key ? String(key).split("/").pop() : id));

    const wordCount = toNumber(pick(raw, ["wordCount", "word_count", "words"]));
    const rawStatus = String(pick(raw, ["status", "processingStatus", "state"]) || "").toLowerCase();
    let status = STATUS_MAP[rawStatus];
    if (!status) {
      // No status attribute: the current processor only writes a record after it
      // has computed analytics, so a record with a word count is a processed one.
      status = rawStatus ? "unknown" : (wordCount !== null ? "processed" : "unknown");
    }

    return {
      id: String(id),
      fileName,
      key: key ? String(key) : null,
      fileType: (fileExtension(fileName).replace(".", "") || "—").toUpperCase(),
      status,
      rawStatus: rawStatus || null,
      uploadedAt: toDate(pick(raw, ["uploadedAt", "uploadDate", "createdAt", "uploadTime", "timestamp"])),
      processedAt: toDate(pick(raw, ["processedAt", "processedDate", "completedAt", "updatedAt"])),
      sizeBytes: toNumber(pick(raw, ["fileSize", "sizeBytes", "size", "contentLength"])),
      wordCount,
      characterCount: toNumber(pick(raw, ["characterCount", "charCount", "character_count", "characters"])),
      paragraphCount: toNumber(pick(raw, ["paragraphCount", "paragraph_count", "paragraphs"])),
      keywords: normaliseKeywords(pick(raw, ["topKeywords", "top_keywords", "keywords", "keywordFrequencies"])),
      errorMessage: pick(raw, ["errorMessage", "error", "failureReason"]) || null
    };
  }

  /* =========================================================
     4. File validation (frontend only — backend must re-check)
     ========================================================= */

  function validateFile(file) {
    const allowed = UPLOAD_RULES.allowedExtensions || [".txt"];
    const maxBytes = UPLOAD_RULES.maxFileSizeBytes || 1024 * 1024;
    const ext = fileExtension(file.name);

    if (!allowed.includes(ext)) {
      return `"${file.name}" is not supported. Allowed type: ${allowed.join(", ")}. PDF support is not available yet.`;
    }
    const allowedMime = UPLOAD_RULES.allowedMimeTypes;
    if (Array.isArray(allowedMime) && !allowedMime.includes(file.type)) {
      return `"${file.name}" does not look like a plain-text file (reported type: ${file.type}).`;
    }
    if (file.size === 0) return `"${file.name}" is empty.`;
    if (file.size > maxBytes) {
      return `"${file.name}" is ${formatBytes(file.size)}. The maximum size is ${formatBytes(maxBytes)}.`;
    }
    return null;
  }

  /* =========================================================
     5. Ui helpers — toasts and loading / empty / error states
     ========================================================= */

  const Ui = {
    toast(type, title, message) {
      const region = $("#toast-region");
      const toast = el("div", { class: `toast toast-${type}`, role: type === "error" ? "alert" : "status" }, [
        el("div", { class: "toast-body" }, [
          el("p", { class: "toast-title", text: title }),
          message ? el("p", { class: "muted small", text: message }) : null
        ]),
        el("button", { class: "toast-close", type: "button", "aria-label": "Dismiss notification", text: "×",
          onclick: () => toast.remove() })
      ]);
      region.append(toast);
      setTimeout(() => toast.remove(), type === "error" ? 9000 : 5000);
    },

    loading(message) {
      return el("div", { class: "state", role: "status" }, [
        el("div", { class: "spinner", "aria-hidden": "true" }),
        el("p", { text: message || "Loading…" })
      ]);
    },

    empty(title, message, action) {
      return el("div", { class: "state" }, [
        icon(ICONS.file),
        el("p", { class: "state-title", text: title }),
        message ? el("p", { class: "small", text: message }) : null,
        action || null
      ]);
    },

    error(message, onRetry) {
      return el("div", { class: "state", role: "alert" }, [
        icon(ICONS.alert),
        el("p", { class: "state-title", text: "Something went wrong" }),
        el("p", { class: "small", text: message }),
        onRetry ? el("button", { class: "btn btn-secondary btn-sm", type: "button", text: "Try again", onclick: onRetry }) : null
      ]);
    },

    notConfigured() {
      return el("div", { class: "state" }, [
        icon(ICONS.plug),
        el("p", { class: "state-title", text: "Not connected to AWS yet" }),
        el("p", { class: "small", text: "No data is shown until the API Gateway endpoint is set in config.js." }),
        el("a", { class: "btn btn-secondary btn-sm", href: "#/setup", text: "View setup steps" })
      ]);
    },

    statusBadge(status) {
      return el("span", { class: `badge badge-${status === "unknown" ? "pending" : status}`, text: STATUS_LABELS[status] || "Unknown" });
    },

    /** Replace all children of a container with a single node. */
    show(container, node) {
      container.replaceChildren(node);
    },

    setApiPill(state, text) {
      const pill = $("#api-pill");
      pill.className = "api-pill" + (state ? " is-" + state : "");
      pill.textContent = text;
    }
  };

  /* =========================================================
     6. State & views
     ========================================================= */

  const state = {
    documents: [],     // last list returned by GET /documents
    loaded: false,     // true after at least one successful load
    loading: false,
    loadError: null,
    selectedFile: null,
    uploading: false
  };

  /** Fetch the document list once and share it between Overview and Documents. */
  async function loadDocuments() {
    if (!isApiConfigured()) return;
    state.loading = true;
    state.loadError = null;
    setRefreshing(true);
    renderCurrentListView();
    try {
      state.documents = await Api.listDocuments();
      state.loaded = true;
      Ui.setApiPill("ok", "API connected");
    } catch (err) {
      state.loadError = err.message;
      Ui.setApiPill("error", "API error");
    } finally {
      state.loading = false;
      setRefreshing(false);
      renderCurrentListView();
    }
  }

  function setRefreshing(on) {
    const btn = $("#refresh-btn");
    btn.disabled = on;
    btn.classList.toggle("is-loading", on);
  }

  function renderCurrentListView() {
    if (currentRoute.name === "dashboard") renderDashboard();
    if (currentRoute.name === "documents") renderDocuments();
  }

  /** Shared loading/error/not-configured handling for list-based views. Returns true if handled. */
  function renderListGuard(container) {
    if (!isApiConfigured()) { Ui.show(container, Ui.notConfigured()); return true; }
    if (state.loading && !state.loaded) { Ui.show(container, Ui.loading("Loading documents from DynamoDB…")); return true; }
    if (state.loadError) { Ui.show(container, Ui.error(state.loadError, loadDocuments)); return true; }
    return false;
  }

  function buildDocumentsTable(docs, { compact } = {}) {
    const headers = compact
      ? ["File name", "Uploaded", "Status", ""]
      : ["File name", "Uploaded", "Type", "Words", "Status", "Actions"];

    const rows = docs.map((doc) => {
      const viewLink = el("a", { class: "btn btn-secondary btn-sm", href: "#/documents/" + encodeURIComponent(doc.id),
        "aria-label": `View details for ${doc.fileName}`, text: "View" });
      const cells = compact
        ? [
            el("td", { class: "file-cell", text: doc.fileName }),
            el("td", { "data-label": "Uploaded", text: formatDate(doc.uploadedAt) }),
            el("td", { "data-label": "Status" }, Ui.statusBadge(doc.status)),
            el("td", { "data-label": "" }, viewLink)
          ]
        : [
            el("td", { class: "file-cell", text: doc.fileName }),
            el("td", { "data-label": "Uploaded", text: formatDate(doc.uploadedAt) }),
            el("td", { "data-label": "Type", text: doc.fileType }),
            el("td", { class: "num", "data-label": "Words", text: formatNumber(doc.wordCount) }),
            el("td", { "data-label": "Status" }, Ui.statusBadge(doc.status)),
            el("td", { "data-label": "Actions" }, viewLink)
          ];
      return el("tr", null, cells);
    });

    return el("div", { class: "table-wrap" },
      el("table", { class: "table responsive" }, [
        el("thead", null, el("tr", null, headers.map((h, i) =>
          el("th", { scope: "col", class: !compact && i === 3 ? "num" : null }, h ? h : el("span", { class: "visually-hidden", text: "Actions" }))))),
        el("tbody", null, rows)
      ]));
  }

  function byNewest(a, b) {
    return (b.uploadedAt ? b.uploadedAt.getTime() : 0) - (a.uploadedAt ? a.uploadedAt.getTime() : 0);
  }

  /* ---------- Overview ---------- */

  function renderDashboard() {
    const counts = { total: "—", processed: "—", pending: "—", failed: "—" };
    if (state.loaded && !state.loadError) {
      counts.total = state.documents.length;
      counts.processed = state.documents.filter((d) => d.status === "processed").length;
      counts.pending = state.documents.filter((d) => d.status === "pending").length;
      counts.failed = state.documents.filter((d) => d.status === "failed").length;
    }
    $("#stat-total").textContent = counts.total;
    $("#stat-processed").textContent = counts.processed;
    $("#stat-pending").textContent = counts.pending;
    $("#stat-failed").textContent = counts.failed;

    const container = $("#recent-container");
    if (renderListGuard(container)) return;
    if (state.documents.length === 0) {
      Ui.show(container, Ui.empty("No documents yet", "Upload a TXT file to start processing.",
        el("a", { class: "btn btn-primary btn-sm", href: "#/upload", text: "Upload a document" })));
      return;
    }
    const recent = [...state.documents].sort(byNewest).slice(0, 5);
    Ui.show(container, buildDocumentsTable(recent, { compact: true }));
  }

  /* ---------- Documents (search / filter / sort) ---------- */

  const SORTERS = {
    "date-desc": byNewest,
    "date-asc": (a, b) => -byNewest(a, b),
    "name-asc": (a, b) => a.fileName.localeCompare(b.fileName),
    "name-desc": (a, b) => b.fileName.localeCompare(a.fileName),
    "words-desc": (a, b) => (b.wordCount ?? -1) - (a.wordCount ?? -1)
  };

  function renderDocuments() {
    const container = $("#documents-container");
    const countEl = $("#result-count");
    countEl.textContent = "";
    if (renderListGuard(container)) return;

    if (state.documents.length === 0) {
      Ui.show(container, Ui.empty("No documents yet", "Documents appear here after they are uploaded and recorded in DynamoDB.",
        el("a", { class: "btn btn-primary btn-sm", href: "#/upload", text: "Upload a document" })));
      return;
    }

    const query = $("#search-input").value.trim().toLowerCase();
    const statusFilter = $("#status-filter").value;
    const sorter = SORTERS[$("#sort-select").value] || byNewest;

    const visible = state.documents
      .filter((d) => !query || d.fileName.toLowerCase().includes(query))
      .filter((d) => statusFilter === "all" || d.status === statusFilter)
      .sort(sorter);

    countEl.textContent = `Showing ${visible.length} of ${state.documents.length} documents`;

    if (visible.length === 0) {
      const empty = Ui.empty("No matching documents", "Try a different search term or status filter.");
      empty.replaceChild(icon(ICONS.search), empty.firstChild);
      Ui.show(container, empty);
      return;
    }
    Ui.show(container, buildDocumentsTable(visible));
  }

  /* ---------- Document details ---------- */

  let detailsRequestId = 0;

  async function renderDetails(documentId) {
    const container = $("#details-container");
    if (!isApiConfigured()) { Ui.show(container, el("div", { class: "panel" }, Ui.notConfigured())); return; }

    const requestId = ++detailsRequestId;
    Ui.show(container, el("div", { class: "panel" }, Ui.loading("Loading document…")));
    setRefreshing(true);
    try {
      const doc = await Api.getDocument(documentId);
      if (requestId !== detailsRequestId) return; // user navigated away
      Ui.show(container, buildDetails(doc));
      $("#page-title").textContent = doc.fileName;
    } catch (err) {
      if (requestId !== detailsRequestId) return;
      const message = err.status === 404
        ? "No record exists for this document. If it was just uploaded, processing may not have finished yet."
        : err.message;
      Ui.show(container, el("div", { class: "panel" }, Ui.error(message, () => renderDetails(documentId))));
    } finally {
      if (requestId === detailsRequestId) setRefreshing(false);
    }
  }

  function metricCard(label, value) {
    return el("article", { class: "stat-card" }, [
      el("p", { class: "stat-label", text: label }),
      el("p", { class: "stat-value", text: formatNumber(value) })
    ]);
  }

  /** Top keywords as a single-hue horizontal bar list. Bar length = count / max count. */
  function keywordChart(keywords) {
    if (!keywords.length) {
      return el("p", { class: "muted small", text: "No keyword data was returned for this document." });
    }
    const top = keywords.slice(0, 10);
    const max = Math.max(...top.map((k) => k.count), 1);
    return el("ol", { class: "kw-list", "aria-label": "Top keywords by frequency" }, top.map((k) =>
      el("li", { class: "kw-row", title: `${k.word}: ${k.count} occurrence${k.count === 1 ? "" : "s"}` }, [
        el("span", { class: "kw-word", text: k.word }),
        el("span", { class: "kw-track", "aria-hidden": "true" },
          el("span", { class: "kw-bar", style: `display:block;width:${(k.count / max) * 100}%` })),
        el("span", { class: "kw-count", text: formatNumber(k.count) })
      ])));
  }

  function buildDetails(doc) {
    const info = el("dl", { class: "kv" }, [
      el("dt", { text: "Document ID" }), el("dd", { class: "mono", text: doc.id }),
      doc.key ? el("dt", { text: "S3 key" }) : null, doc.key ? el("dd", { class: "mono", text: doc.key }) : null,
      el("dt", { text: "File type" }), el("dd", { text: doc.fileType }),
      el("dt", { text: "Uploaded" }), el("dd", { text: formatDate(doc.uploadedAt) }),
      el("dt", { text: "Processed" }), el("dd", { text: formatDate(doc.processedAt) }),
      doc.sizeBytes !== null ? el("dt", { text: "Size" }) : null,
      doc.sizeBytes !== null ? el("dd", { text: formatBytes(doc.sizeBytes) }) : null
    ]);

    const parts = [
      el("div", { class: "panel" }, [
        el("div", { class: "details-header" }, [
          el("h2", { class: "details-title", text: doc.fileName }),
          Ui.statusBadge(doc.status)
        ]),
        info
      ])
    ];

    if (doc.status === "failed") {
      parts.push(el("div", { class: "notice notice-error" }, [
        el("strong", { text: "Processing failed. " }), doc.errorMessage || "No error details were returned."
      ]));
    } else if (doc.status !== "processed") {
      parts.push(el("div", { class: "notice notice-info", text:
        "This document has not finished processing. Use Refresh to check again." }));
    }

    if (doc.status === "processed") {
      parts.push(el("div", { class: "metric-grid" }, [
        metricCard("Word count", doc.wordCount),
        metricCard("Character count", doc.characterCount),
        metricCard("Paragraph count", doc.paragraphCount)
      ]));
      parts.push(el("div", { class: "panel" }, [
        el("div", { class: "panel-header" }, el("h2", { text: "Top keywords" })),
        keywordChart(doc.keywords)
      ]));
    }

    return el("div", { class: "view" }, parts);
  }

  /* ---------- Upload ---------- */

  function setupUpload() {
    const allowed = (UPLOAD_RULES.allowedExtensions || [".txt"]).join(", ");
    const max = formatBytes(UPLOAD_RULES.maxFileSizeBytes || 1024 * 1024);
    $("#upload-rules").textContent = `Accepted: ${allowed} files up to ${max}. PDF is not supported yet.`;
    $("#file-input").setAttribute("accept", allowed);

    const dropzone = $("#dropzone");
    const input = $("#file-input");

    input.addEventListener("change", () => {
      if (input.files.length) selectFile(input.files);
      input.value = ""; // allow re-selecting the same file
    });

    ["dragenter", "dragover"].forEach((type) => dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      if (!state.uploading) dropzone.classList.add("is-dragover");
    }));
    ["dragleave", "drop"].forEach((type) => dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-dragover");
    }));
    dropzone.addEventListener("drop", (e) => {
      if (!state.uploading && e.dataTransfer && e.dataTransfer.files.length) selectFile(e.dataTransfer.files);
    });
    // Stop the browser from opening files dropped outside the drop zone.
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());

    $("#clear-file-btn").addEventListener("click", clearSelectedFile);
    $("#upload-btn").addEventListener("click", startUpload);
    updateUploadControls();
  }

  function selectFile(fileList) {
    const errorEl = $("#file-error");
    if (fileList.length > 1) {
      showFileError("Please upload one file at a time.");
      return;
    }
    const file = fileList[0];
    const problem = validateFile(file);
    if (problem) {
      clearSelectedFile();
      showFileError(problem);
      return;
    }
    errorEl.hidden = true;
    state.selectedFile = file;
    $("#selected-name").textContent = file.name;
    $("#selected-meta").textContent = `${formatBytes(file.size)} · ${fileExtension(file.name).slice(1).toUpperCase()}`;
    $("#selected-file").hidden = false;
    updateUploadControls();
  }

  function showFileError(message) {
    const errorEl = $("#file-error");
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function clearSelectedFile() {
    state.selectedFile = null;
    $("#selected-file").hidden = true;
    $("#file-error").hidden = true;
    updateUploadControls();
  }

  function updateUploadControls() {
    const btn = $("#upload-btn");
    btn.disabled = !state.selectedFile || state.uploading || !isApiConfigured();
    btn.textContent = state.uploading ? "Uploading…" : "Upload to S3";
    $("#clear-file-btn").disabled = state.uploading;
    $("#file-input").disabled = state.uploading;
    $("#dropzone").classList.toggle("is-disabled", state.uploading);
    if (!isApiConfigured()) {
      btn.title = "Configure apiBaseUrl in config.js to enable uploads";
    } else {
      btn.removeAttribute("title");
    }
  }

  function setProgress(fraction, text) {
    $("#upload-progress").hidden = false;
    $("#upload-progress-bar").style.width = Math.round(fraction * 100) + "%";
    $("#upload-progress-text").textContent = text;
  }

  /**
   * Full upload flow:
   *   1. POST /uploads  -> presigned URL (API Lambda)
   *   2. PUT file to S3 -> object lands in incoming/, S3 event triggers DocumentProcessor
   *   3. Poll GET /documents/{id} until the record shows a final status
   */
  async function startUpload() {
    const file = state.selectedFile;
    if (!file || state.uploading) return;
    if (!isApiConfigured()) {
      Ui.toast("error", "API not configured", "Set apiBaseUrl in config.js before uploading.");
      return;
    }
    const problem = validateFile(file); // re-check in case config changed
    if (problem) { showFileError(problem); return; }

    state.uploading = true;
    updateUploadControls();
    setProgress(0, "Requesting a secure upload URL…");

    try {
      const { uploadUrl, documentId } = await Api.requestUploadUrl(file);
      setProgress(0, "Uploading to Amazon S3…");
      await Api.uploadToS3(uploadUrl, file, (f) => setProgress(f, `Uploading to Amazon S3… ${Math.round(f * 100)}%`));
      setProgress(1, "Upload complete.");
      Ui.toast("success", "Upload complete", `${file.name} was stored in S3. Processing has been triggered.`);
      clearSelectedFile();
      if (documentId) {
        trackProcessing(String(documentId), file.name);
      } else {
        showUploadStatus(Ui.empty("Uploaded", "The API did not return a document ID, so status cannot be tracked here. Check the Documents page shortly."));
      }
    } catch (err) {
      $("#upload-progress").hidden = true;
      showFileError(err.message);
      Ui.toast("error", "Upload failed", err.message);
    } finally {
      state.uploading = false;
      updateUploadControls();
    }
  }

  function showUploadStatus(node) {
    $("#upload-status-panel").hidden = false;
    Ui.show($("#upload-status"), node);
  }

  let trackingToken = 0;

  /** Poll the API until DocumentProcessor has written a final result (or we give up). */
  async function trackProcessing(documentId, fileName) {
    const token = ++trackingToken;
    const { intervalMs = 3000, maxAttempts = 20 } = CONFIG.polling || {};

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (token !== trackingToken) return; // a newer upload replaced this one
      showUploadStatus(Ui.loading(`Waiting for DocumentProcessor to analyse ${fileName}… (check ${attempt} of ${maxAttempts})`));
      await sleep(intervalMs);
      try {
        const doc = await Api.getDocument(documentId);
        if (doc.status === "processed" || doc.status === "failed") {
          if (token !== trackingToken) return;
          const ok = doc.status === "processed";
          showUploadStatus(el("div", { class: "state" }, [
            Ui.statusBadge(doc.status),
            el("p", { class: "state-title", text: ok ? `${fileName} has been processed` : `Processing failed for ${fileName}` }),
            ok ? el("p", { class: "small", text: `${formatNumber(doc.wordCount)} words · ${formatNumber(doc.paragraphCount)} paragraphs` })
               : el("p", { class: "small", text: doc.errorMessage || "No error details were returned." }),
            el("a", { class: "btn btn-secondary btn-sm", href: "#/documents/" + encodeURIComponent(doc.id), text: "View details" })
          ]));
          Ui.toast(ok ? "success" : "error", ok ? "Processing complete" : "Processing failed", fileName);
          loadDocuments();
          return;
        }
      } catch (err) {
        // 404 just means the processor has not written the record yet; keep waiting.
        if (err.status !== 404) {
          if (token !== trackingToken) return;
          showUploadStatus(Ui.error(`Could not check processing status: ${err.message}`,
            () => trackProcessing(documentId, fileName)));
          return;
        }
      }
    }
    if (token !== trackingToken) return;
    showUploadStatus(Ui.empty("Still processing",
      "The result is not available yet. Check the Documents page again in a moment.",
      el("a", { class: "btn btn-secondary btn-sm", href: "#/documents", text: "Go to documents" })));
    loadDocuments();
  }

  /* ---------- Setup ---------- */

  function renderSetup() {
    const configured = isApiConfigured();
    $("#setup-status").replaceChildren(
      el("dt", { text: "API base URL" }),
      el("dd", { class: "mono", text: configured ? API_BASE : "Not set (config.js → apiBaseUrl)" }),
      el("dt", { text: "AWS region" }),
      el("dd", { class: "mono", text: CONFIG.awsRegion || "—" }),
      el("dt", { text: "Upload rules" }),
      el("dd", { text: `${(UPLOAD_RULES.allowedExtensions || []).join(", ")} up to ${formatBytes(UPLOAD_RULES.maxFileSizeBytes)}` }),
      el("dt", { text: "Last API check" }),
      el("dd", { text: !configured ? "Skipped — API not configured"
        : state.loadError ? "Failed: " + state.loadError
        : state.loaded ? "OK — GET /documents returned " + state.documents.length + " record(s)"
        : "Not checked yet" })
    );
  }

  /* =========================================================
     7. Router & startup
     ========================================================= */

  const ROUTE_TITLES = { dashboard: "Overview", upload: "Upload", documents: "Documents", details: "Document details", setup: "API setup" };
  let currentRoute = { name: "dashboard", param: null };

  /** Hash-based routing: #/dashboard, #/upload, #/documents, #/documents/<id>, #/setup */
  function parseHash() {
    const parts = location.hash.replace(/^#\/?/, "").split("/");
    if (parts[0] === "documents" && parts[1]) return { name: "details", param: decodeURIComponent(parts.slice(1).join("/")) };
    return { name: ROUTE_TITLES[parts[0]] ? parts[0] : "dashboard", param: null };
  }

  function navigate() {
    currentRoute = parseHash();
    const { name, param } = currentRoute;

    document.querySelectorAll(".view").forEach((view) => { view.hidden = view.dataset.view !== name; });
    document.querySelectorAll(".nav-link").forEach((link) => {
      const active = link.dataset.route === name || (name === "details" && link.dataset.route === "documents");
      if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    });
    $("#page-title").textContent = ROUTE_TITLES[name];
    document.title = ROUTE_TITLES[name] + " — DocAnalytics";
    closeSidebar();

    if (name === "dashboard") renderDashboard();
    if (name === "documents") renderDocuments();
    if (name === "details") renderDetails(param);
    if (name === "setup") renderSetup();
  }

  function refreshCurrentView() {
    if (!isApiConfigured()) {
      Ui.toast("info", "API not configured", "Set apiBaseUrl in config.js to load data from AWS.");
      return;
    }
    if (currentRoute.name === "details") renderDetails(currentRoute.param);
    else loadDocuments().then(() => { if (currentRoute.name === "setup") renderSetup(); });
  }

  /* Mobile sidebar */
  function openSidebar() {
    $("#sidebar").classList.add("is-open");
    $("#sidebar-backdrop").hidden = false;
    $("#menu-btn").setAttribute("aria-expanded", "true");
  }
  function closeSidebar() {
    $("#sidebar").classList.remove("is-open");
    $("#sidebar-backdrop").hidden = true;
    $("#menu-btn").setAttribute("aria-expanded", "false");
  }

  function init() {
    $("#sidebar-region").textContent = CONFIG.awsRegion || "—";
    $("#menu-btn").addEventListener("click", () =>
      $("#sidebar").classList.contains("is-open") ? closeSidebar() : openSidebar());
    $("#sidebar-backdrop").addEventListener("click", closeSidebar);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSidebar(); });
    $("#refresh-btn").addEventListener("click", refreshCurrentView);

    $("#filters").addEventListener("submit", (e) => e.preventDefault());
    ["input", "change"].forEach((type) => $("#filters").addEventListener(type, renderDocuments));

    setupUpload();

    if (isApiConfigured()) {
      $("#setup-banner").hidden = true;
      Ui.setApiPill("", "Connecting…");
    } else {
      $("#setup-banner").hidden = false;
      Ui.setApiPill("warn", "API not configured");
    }

    window.addEventListener("hashchange", navigate);
    if (!location.hash) history.replaceState(null, "", "#/dashboard");
    navigate();
    loadDocuments();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
