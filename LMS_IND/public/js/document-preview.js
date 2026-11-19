(function () {
  "use strict";

  var PDF_MODULE_URL = "/vendor/pdfjs/pdf.mjs";
  var PDF_WORKER_URL = "/vendor/pdfjs/pdf.worker.mjs";
  var pdfjsPromise = null;
  var viewers = new WeakMap();

  function icon(name) {
    var paths = {
      left: '<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />',
      right: '<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />',
      download:
        '<path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />',
      sun: '<circle cx="12" cy="12" r="4" /><path stroke-linecap="round" d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3l1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3l1.42-1.42" />',
      moon: '<path stroke-linecap="round" stroke-linejoin="round" d="M20.4 14.5A8.5 8.5 0 019.5 3.6 8.5 8.5 0 1020.4 14.5z" />',
    };
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true">' +
      (paths[name] || "") +
      "</svg>"
    );
  }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatBytes(bytes) {
    var value = Number(bytes) || 0;
    if (value < 1024) return value + " B";
    if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10240 ? 1 : 0) + " KB";
    return (value / (1024 * 1024)).toFixed(1) + " MB";
  }

  function kindLabel(preview) {
    return (
      {
        pdf: "PDF",
        html: "Document",
        slides: "Slides",
        sheets: "Spreadsheet",
        text: "Text",
        image: "Image",
      }[preview.kind] || "Document"
    );
  }

  async function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(PDF_MODULE_URL).then(function (module) {
        module.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
        return module;
      });
    }
    return pdfjsPromise;
  }

  function toolbar(container, preview, state, handlers) {
    var bar = make("div", "dv-toolbar");
    var left = make("div", "dv-toolbar-group");
    left.appendChild(make("span", "dv-kind-badge", kindLabel(preview)));
    var counter = make("span", "dv-counter", "");
    left.appendChild(counter);

    var right = make("div", "dv-toolbar-group");
    var prev = make("button", "dv-btn");
    prev.type = "button";
    prev.title = "Previous page or slide";
    prev.setAttribute("aria-label", "Previous page or slide");
    prev.innerHTML = icon("left");
    prev.hidden = true;

    var next = make("button", "dv-btn");
    next.type = "button";
    next.title = "Next page or slide";
    next.setAttribute("aria-label", "Next page or slide");
    next.innerHTML = icon("right");
    next.hidden = true;

    var zoomOut = make("button", "dv-btn", "−");
    zoomOut.type = "button";
    zoomOut.title = "Zoom out";
    zoomOut.setAttribute("aria-label", "Zoom out");
    var zoomLabel = make("span", "dv-zoom-label", "100%");
    var zoomIn = make("button", "dv-btn", "+");
    zoomIn.type = "button";
    zoomIn.title = "Zoom in";
    zoomIn.setAttribute("aria-label", "Zoom in");

    var theme = make("button", "dv-btn");
    theme.type = "button";
    theme.title = "Toggle dark preview";
    theme.setAttribute("aria-label", "Toggle dark preview");

    var download = make("a", "dv-btn");
    download.href = preview.downloadUrl || preview.fileUrl || "#";
    download.download = preview.fileName || "document";
    download.title = "Download original file";
    download.setAttribute("aria-label", "Download original file");
    download.innerHTML = icon("download");
    if (!preview.fileUrl && !preview.downloadUrl) download.hidden = true;

    right.appendChild(prev);
    right.appendChild(next);
    right.appendChild(zoomOut);
    right.appendChild(zoomLabel);
    right.appendChild(zoomIn);
    right.appendChild(theme);
    right.appendChild(download);
    bar.appendChild(left);
    bar.appendChild(right);

    prev.addEventListener("click", handlers.prev);
    next.addEventListener("click", handlers.next);
    zoomOut.addEventListener("click", handlers.zoomOut);
    zoomIn.addEventListener("click", handlers.zoomIn);
    theme.addEventListener("click", handlers.theme);
    container.appendChild(bar);

    return {
      counter: counter,
      prev: prev,
      next: next,
      zoomLabel: zoomLabel,
      theme: theme,
      setCounter: function (text) {
        counter.textContent = text || "";
      },
      setNavigation: function (visible) {
        prev.hidden = !visible;
        next.hidden = !visible;
      },
      setNavDisabled: function (prevDisabled, nextDisabled) {
        prev.disabled = Boolean(prevDisabled);
        next.disabled = Boolean(nextDisabled);
      },
      setZoom: function (value) {
        zoomLabel.textContent = Math.round(value * 100) + "%";
        zoomOut.disabled = value <= 0.5;
        zoomIn.disabled = value >= 2.5;
      },
      setTheme: function (themeName) {
        theme.innerHTML = icon(themeName === "dark" ? "sun" : "moon");
      },
    };
  }

  function mount(container, preview, options) {
    if (!container || !preview) return null;
    if (viewers.has(container)) viewers.get(container).destroy();
    container.replaceChildren();
    container.classList.add("doc-viewer");
    container.setAttribute("data-theme", "light");

    var state = {
      zoom: 1,
      theme: "light",
      pages: 0,
      page: 1,
      canPrev: false,
      canNext: false,
      destroyed: false,
      cleanup: [],
    };

    var stage = make("div", "dv-stage");
    var notes = [];
    if (Array.isArray(preview.warnings)) {
      notes = preview.warnings.filter(Boolean).slice(0, 3);
    }

    function applyTheme() {
      container.setAttribute("data-theme", state.theme);
      chrome.setTheme(state.theme);
    }

    function zoomBy(delta) {
      state.zoom = Math.max(0.5, Math.min(2.5, Math.round((state.zoom + delta) * 10) / 10));
      chrome.setZoom(state.zoom);
      if (preview.kind === "pdf") renderPdf();
      else if (preview.kind === "slides") sizeSlide();
      else if (preview.kind === "sheets") applySheetZoom();
      else if (richNode) richNode.style.zoom = state.zoom;
    }

    var handlers = {
      prev: function () {
        if (preview.kind === "pdf") scrollToPage(state.page - 1);
        else if (preview.kind === "slides") showSlide(state.page - 1);
        else if (preview.kind === "sheets") showSheet(state.page - 1);
      },
      next: function () {
        if (preview.kind === "pdf") scrollToPage(state.page + 1);
        else if (preview.kind === "slides") showSlide(state.page + 1);
        else if (preview.kind === "sheets") showSheet(state.page + 1);
      },
      zoomOut: function () {
        zoomBy(-0.25);
      },
      zoomIn: function () {
        zoomBy(0.25);
      },
      theme: function () {
        state.theme = state.theme === "dark" ? "light" : "dark";
        applyTheme();
      },
    };

    var chrome = toolbar(container, preview, state, handlers);
    container.appendChild(stage);
    chrome.setZoom(state.zoom);
    applyTheme();

    var richNode = null;
    var slideFrame = null;
    var slideCanvas = null;
    var slideIndex = 0;
    var sheetIndex = 0;
    var sheetZoom = null;
    var pdfDoc = null;
    var pdfRoot = null;
    var pageObserver = null;

    function addNote() {
      if (!notes.length) return;
      var note = make("p", "dv-note", notes.join(" "));
      container.appendChild(note);
    }

    function emptyState(title, message) {
      stage.replaceChildren();
      stage.classList.remove("is-rich", "is-slides");
      var empty = make("div", "dv-empty");
      empty.appendChild(make("strong", "", title));
      empty.appendChild(make("span", "", message || ""));
      stage.appendChild(empty);
    }

    async function renderPdf() {
      if (!preview.fileUrl) {
        emptyState("Preview unavailable", "The document file is missing.");
        return;
      }
      stage.replaceChildren();
      stage.classList.remove("is-rich", "is-slides");
      var loading = make("div", "dv-empty");
      loading.appendChild(make("span", "doc-upload-spinner"));
      loading.appendChild(make("strong", "", "Rendering PDF…"));
      loading.appendChild(make("span", "", "Preparing " + (preview.fileName || "document")));
      stage.appendChild(loading);

      try {
        var pdfjs = await loadPdfjs();
        if (state.destroyed) return;
        if (pdfDoc) {
          await pdfDoc.destroy().catch(function () {});
          pdfDoc = null;
        }
        if (pageObserver) {
          pageObserver.disconnect();
          pageObserver = null;
        }
        pdfDoc = await pdfjs.getDocument({
          url: preview.fileUrl,
          withCredentials: true,
          isEvalSupported: false,
          cMapUrl: "/vendor/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
          wasmUrl: "/vendor/pdfjs/wasm/",
          iccUrl: "/vendor/pdfjs/iccs/",
        }).promise;
        if (state.destroyed) return;
        var root = make("div", "dv-pdf-pages");
        pdfRoot = root;
        stage.replaceChildren(root);
        state.pages = pdfDoc.numPages;
        state.page = 1;
        chrome.setNavigation(true);
        chrome.setCounter("1 / " + pdfDoc.numPages + " pages");
        chrome.setNavDisabled(true, pdfDoc.numPages <= 1);
        var available = Math.max(280, stage.clientWidth - 26);
        var dpr = Math.min(window.devicePixelRatio || 1, 2);

        for (var number = 1; number <= pdfDoc.numPages; number += 1) {
          if (state.destroyed) return;
          var page = await pdfDoc.getPage(number);
          var base = page.getViewport({ scale: 1 });
          var fit = Math.min(1.55, available / base.width) * state.zoom;
          var viewport = page.getViewport({ scale: Math.max(0.2, fit) });
          var wrap = make("div", "dv-pdf-page");
          wrap.dataset.page = String(number);
          var canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = viewport.width + "px";
          canvas.style.height = viewport.height + "px";
          canvas.setAttribute("aria-label", "PDF page " + number);
          wrap.appendChild(canvas);
          var badge = make("span", "dv-page-number", String(number));
          wrap.appendChild(badge);
          root.appendChild(wrap);
          await page.render({
            canvasContext: canvas.getContext("2d", { alpha: false }),
            viewport: viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
          }).promise;
          if (number === 1) {
            chrome.setCounter("1 / " + pdfDoc.numPages + " pages");
            chrome.setNavDisabled(true, pdfDoc.numPages <= 1);
          }
        }
        observePdfPages();
      } catch (error) {
        if (state.destroyed) return;
        console.error("PDF preview failed:", error);
        emptyState(
          "PDF preview could not be rendered",
          "Use Download to open the original file. " + (error.message || "")
        );
      }
    }

    function observePdfPages() {
      if (!pdfRoot || typeof IntersectionObserver !== "function") return;
      pageObserver = new IntersectionObserver(
        function (entries) {
          var visible = entries
            .filter(function (entry) {
              return entry.isIntersecting;
            })
            .sort(function (a, b) {
              return b.intersectionRatio - a.intersectionRatio;
            })[0];
          if (!visible) return;
          state.page = Number(visible.target.dataset.page) || 1;
          chrome.setCounter(state.page + " / " + state.pages + " pages");
          chrome.setNavDisabled(state.page <= 1, state.page >= state.pages);
        },
        { root: stage, threshold: [0.35, 0.65] }
      );
      pdfRoot.querySelectorAll(".dv-pdf-page").forEach(function (page) {
        pageObserver.observe(page);
      });
    }

    function scrollToPage(number) {
      if (!pdfRoot) return;
      var target = Math.max(1, Math.min(state.pages, number));
      var page = pdfRoot.querySelector('[data-page="' + target + '"]');
      if (!page) return;
      state.page = target;
      chrome.setCounter(state.page + " / " + state.pages + " pages");
      chrome.setNavDisabled(state.page <= 1, state.page >= state.pages);
      page.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function renderRich() {
      stage.classList.add("is-rich");
      stage.replaceChildren();
      richNode = make("div", "dv-rich-paper");
      richNode.innerHTML = preview.html || "";
      stage.appendChild(richNode);
      richNode.style.zoom = state.zoom;
      chrome.setNavigation(false);
      chrome.setCounter(
        preview.kind === "html"
          ? "Formatted document"
          : "Text document"
      );
    }

    function renderText() {
      stage.classList.add("is-rich");
      stage.replaceChildren();
      richNode = make("pre", "dv-text", preview.text || "");
      stage.appendChild(richNode);
      richNode.style.zoom = state.zoom;
      chrome.setNavigation(false);
      chrome.setCounter("Text document");
    }

    function renderImage() {
      stage.classList.add("is-plain");
      stage.replaceChildren();
      if (!preview.fileUrl) {
        emptyState("Preview unavailable", "The image file is missing.");
        return;
      }
      var frame = make("div", "dv-image-frame");
      var image = document.createElement("img");
      image.src = preview.fileUrl;
      image.alt = preview.fileName || "Uploaded image";
      image.addEventListener("load", function () {
        chrome.setCounter(image.naturalWidth + " × " + image.naturalHeight + " px");
      });
      image.addEventListener("error", function () {
        emptyState("Image preview failed", "Use Download to open the original image.");
      });
      frame.appendChild(image);
      stage.appendChild(frame);
      richNode = image;
      image.style.zoom = state.zoom;
      chrome.setNavigation(false);
    }

    function sizeSlide() {
      if (!slideFrame || !slideCanvas) return;
      var available = Math.max(240, stage.clientWidth - 30);
      var fit = available / preview.width;
      var scale = Math.max(0.2, fit * state.zoom);
      slideCanvas.style.transform = "scale(" + scale + ")";
      slideFrame.style.width = Math.round(preview.width * scale) + "px";
      slideFrame.style.height = Math.round(preview.height * scale) + "px";
    }

    function showSlide(number) {
      if (!preview.slides || !preview.slides.length) return;
      slideIndex = Math.max(0, Math.min(preview.slides.length - 1, number));
      state.page = slideIndex + 1;
      var slide = preview.slides[slideIndex];
      slideCanvas.style.background = slide.background || "#ffffff";
      slideCanvas.innerHTML = slide.html || "";
      chrome.setCounter("Slide " + (slideIndex + 1) + " / " + preview.slides.length);
      chrome.setNavDisabled(slideIndex === 0, slideIndex >= preview.slides.length - 1);
      sizeSlide();
    }

    function renderSlides() {
      if (!preview.slides || !preview.slides.length) {
        emptyState("No slides found", "The presentation has no readable slide content.");
        return;
      }
      stage.classList.add("is-slides");
      stage.replaceChildren();
      slideFrame = make("div", "dv-slide-frame");
      slideCanvas = make("div", "dv-slide-canvas");
      slideCanvas.style.width = preview.width + "px";
      slideCanvas.style.height = preview.height + "px";
      slideFrame.appendChild(slideCanvas);
      stage.appendChild(slideFrame);
      chrome.setNavigation(true);
      slideIndex = 0;
      state.pages = preview.slides.length;
      showSlide(0);
    }

    function applySheetZoom() {
      if (!sheetZoom) return;
      sheetZoom.style.zoom = state.zoom;
    }

    function showSheet(number) {
      if (!preview.sheets || !preview.sheets.length) return;
      sheetIndex = Math.max(0, Math.min(preview.sheets.length - 1, number));
      state.page = sheetIndex + 1;
      var sheet = preview.sheets[sheetIndex];
      Array.prototype.forEach.call(
        stage.querySelectorAll(".dv-sheet-tab"),
        function (tab, index) {
          tab.classList.toggle("is-active", index === sheetIndex);
        }
      );
      sheetZoom.replaceChildren();
      var wrap = make("div", "dv-sheet-wrap");
      var table = make("table", "dv-sheet-table");
      var columnCount = sheet.rows.reduce(function (max, row) {
        return Math.max(max, row.length);
      }, 0);
      if (columnCount) {
        var thead = document.createElement("thead");
        var headRow = document.createElement("tr");
        headRow.appendChild(make("th", "dv-row-number", "#"));
        for (var column = 0; column < columnCount; column += 1) {
          var label = "";
          var value = column;
          do {
            label = String.fromCharCode(65 + (value % 26)) + label;
            value = Math.floor(value / 26) - 1;
          } while (value >= 0);
          headRow.appendChild(make("th", "", label));
        }
        thead.appendChild(headRow);
        table.appendChild(thead);
      }
      var tbody = document.createElement("tbody");
      sheet.rows.forEach(function (row, rowIndex) {
        var tr = document.createElement("tr");
        tr.appendChild(make("td", "dv-row-number", String(rowIndex + 1)));
        for (var column = 0; column < columnCount; column += 1) {
          tr.appendChild(make("td", "", row[column] == null ? "" : row[column]));
        }
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      sheetZoom.appendChild(wrap);
      chrome.setCounter(
        "Sheet " + (sheetIndex + 1) + " / " + preview.sheets.length +
          (sheet.rows.length ? " · " + sheet.rows.length + " rows" : "")
      );
      chrome.setNavDisabled(sheetIndex === 0, sheetIndex >= preview.sheets.length - 1);
      applySheetZoom();
    }

    function renderSheets() {
      if (!preview.sheets || !preview.sheets.length) {
        emptyState("No spreadsheet data", "No readable cells were found in this workbook.");
        return;
      }
      stage.classList.remove("is-rich");
      stage.classList.add("is-rich");
      stage.replaceChildren();
      var tabs = make("div", "dv-sheet-tabs");
      preview.sheets.forEach(function (sheet, index) {
        var tab = make("button", "dv-sheet-tab", sheet.name || "Sheet " + (index + 1));
        tab.type = "button";
        tab.addEventListener("click", function () {
          showSheet(index);
        });
        tabs.appendChild(tab);
      });
      stage.appendChild(tabs);
      sheetZoom = make("div", "dv-sheet-zoom");
      stage.appendChild(sheetZoom);
      chrome.setNavigation(preview.sheets.length > 1);
      state.pages = preview.sheets.length;
      showSheet(0);
    }

    function render() {
      if (preview.kind === "pdf") renderPdf();
      else if (preview.kind === "image") renderImage();
      else if (preview.kind === "slides") renderSlides();
      else if (preview.kind === "sheets") renderSheets();
      else if (preview.kind === "text") renderText();
      else if (preview.kind === "html") renderRich();
      else emptyState("Preview unavailable", "This document type is not supported.");
      addNote();
    }

    var resizeTimer = null;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (state.destroyed) return;
        if (preview.kind === "slides") sizeSlide();
        else if (preview.kind === "pdf" && state.zoom !== 1) renderPdf();
      }, 180);
    }
    window.addEventListener("resize", onResize);
    state.cleanup.push(function () {
      window.removeEventListener("resize", onResize);
    });

    render();

    var api = {
      destroy: function () {
        if (state.destroyed) return;
        state.destroyed = true;
        if (pageObserver) pageObserver.disconnect();
        if (pdfDoc) pdfDoc.destroy().catch(function () {});
        state.cleanup.forEach(function (fn) {
          try {
            fn();
          } catch (error) {
            console.warn("Viewer cleanup failed:", error);
          }
        });
        viewers.delete(container);
        container.replaceChildren();
      },
      setTheme: function (theme) {
        state.theme = theme === "dark" ? "dark" : "light";
        applyTheme();
      },
    };
    viewers.set(container, api);
    if (options && options.theme === "dark") api.setTheme("dark");
    return api;
  }

  window.DocumentPreview = {
    mount: mount,
    formatBytes: formatBytes,
  };
})();
