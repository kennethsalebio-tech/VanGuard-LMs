(function () {
  "use strict";

  var ALLOWED = [
    ".pdf",
    ".docx",
    ".pptx",
    ".xlsx",
    ".txt",
    ".md",
    ".markdown",
    ".html",
    ".htm",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
  ];
  var STAGES = ["preparing", "uploading", "processing", "preview"];

  function formatBytes(bytes) {
    var value = Number(bytes) || 0;
    if (value < 1024) return value + " B";
    if (value < 1024 * 1024) {
      return (value / 1024).toFixed(value < 10240 ? 1 : 0) + " KB";
    }
    return (value / (1024 * 1024)).toFixed(1) + " MB";
  }

  function extensionOf(name) {
    var index = String(name || "").lastIndexOf(".");
    return index >= 0 ? String(name).slice(index).toLowerCase() : "";
  }

  function labelForExtension(extension) {
    return (extension || "file").replace(".", "").slice(0, 5).toUpperCase();
  }

  function initForm(form) {
    var input = form.querySelector("[data-file-input]");
    var dropzone = form.querySelector("[data-dropzone]");
    var tokenInput = form.querySelector("[data-upload-token]");
    var progress = form.querySelector("[data-progress]");
    var progressBar = form.querySelector("[data-progress-bar]");
    var progressTrack = form.querySelector("[data-progress-track]");
    var progressPercent = form.querySelector("[data-progress-percent]");
    var progressStatus = form.querySelector("[data-progress-status]");
    var progressName = form.querySelector("[data-progress-name]");
    var spinner = form.querySelector("[data-spinner]");
    var errorBox = form.querySelector("[data-upload-error]");
    var errorMessage = form.querySelector("[data-error-message]");
    var retry = form.querySelector("[data-retry]");
    var result = form.querySelector("[data-upload-result]");
    var previewBody = form.querySelector("[data-preview-body]");
    var fileName = form.querySelector("[data-file-name]");
    var fileMeta = form.querySelector("[data-file-meta]");
    var fileIcon = form.querySelector("[data-file-icon]");
    var remove = form.querySelector("[data-remove]");
    var submit = form.querySelector("[data-submit]");
    var csrf = form.dataset.csrf || form.querySelector('input[name="_csrf"]')?.value;
    var maxSize = Number(form.dataset.maxSize) || 25 * 1024 * 1024;
    var uploadUrl = form.dataset.uploadUrl;
    var removeBase = form.dataset.removeBase;
    var dragDepth = 0;

    if (!input || !dropzone || !tokenInput || !uploadUrl) return;

    var state = {
      file: null,
      token: null,
      preview: null,
      info: null,
      uploading: false,
      removing: false,
      xhr: null,
      processingTimer: null,
      previous: null,
    };

    function updateStages(active, allComplete) {
      STAGES.forEach(function (stage, index) {
        var node = form.querySelector('[data-stage="' + stage + '"]');
        if (!node) return;
        node.dataset.active = String(stage === active && !allComplete);
        node.dataset.complete = String(
          allComplete || (active ? STAGES.indexOf(active) > index : false)
        );
      });
    }

    function resetProgress() {
      clearTimeout(state.processingTimer);
      state.processingTimer = null;
      progress.hidden = true;
      progressBar.style.width = "0%";
      progressPercent.textContent = "0%";
      progressStatus.textContent = "Preparing file…";
      progressName.textContent = "";
      progressTrack.classList.remove("is-indeterminate");
      spinner.classList.remove("is-done");
      updateStages("preparing", false);
    }

    function showError(message) {
      resetProgress();
      errorMessage.textContent = message || "The upload did not complete. Please try again.";
      errorBox.hidden = false;
      if (state.previous) {
        restore(state.previous);
      }
    }

    function hideError() {
      errorBox.hidden = true;
      errorMessage.textContent = "";
    }

    function setBusy(busy) {
      state.uploading = busy;
      form.classList.toggle("is-busy", busy);
      dropzone.classList.toggle("is-uploading", busy);
      submit.disabled = busy;
      submit.setAttribute("aria-disabled", String(busy));
    }

    function validate(file) {
      if (!file) return "Choose a document to upload.";
      var extension = extensionOf(file.name);
      if (!ALLOWED.includes(extension)) {
        return (
          "Unsupported file type" +
          (extension ? " (" + extension + ")" : "") +
          ". Use PDF, DOCX, PPTX, XLSX, TXT, Markdown, HTML, PNG, JPG, GIF, or WebP."
        );
      }
      if (!file.size) return "This file is empty. Choose another document.";
      if (file.size > maxSize) {
        return (
          "This file is " +
          formatBytes(file.size) +
          ". The maximum size is " +
          formatBytes(maxSize) +
          "."
        );
      }
      return null;
    }

    function restore(previous) {
      if (!previous || !previous.token) return;
      state.token = previous.token;
      state.preview = previous.preview;
      tokenInput.value = previous.token;
      result.hidden = false;
      dropzone.hidden = true;
      fileName.textContent = previous.info.name;
      fileMeta.textContent =
        formatBytes(previous.info.size) + " · " + previous.info.mimeType;
      fileIcon.textContent = labelForExtension(previous.info.extension);
      if (window.DocumentPreview && previous.preview) {
        window.DocumentPreview.mount(previewBody, previous.preview);
      }
    }

    function clearResult() {
      if (window.DocumentPreview && previewBody) {
        var active = previewBody.__viewer;
        if (active && active.destroy) active.destroy();
      }
      previewBody.replaceChildren();
      result.hidden = true;
      fileName.textContent = "";
      fileMeta.textContent = "";
      fileIcon.textContent = "";
      tokenInput.value = "";
      state.token = null;
      state.preview = null;
      state.info = null;
    }

    function handleSuccess(payload, file) {
      clearTimeout(state.processingTimer);
      state.processingTimer = null;
      progressTrack.classList.remove("is-indeterminate");
      progressBar.style.width = "100%";
      progressPercent.textContent = "100%";
      progressStatus.textContent = "Upload completed!";
      updateStages("preview", true);
      spinner.classList.add("is-done");
      spinner.textContent = "✓";
      setBusy(false);
      hideError();

      state.token = payload.token;
      state.preview = payload.preview;
      state.info = payload.file;
      tokenInput.value = payload.token;
      input.value = "";
      input.setAttribute("data-cleared", "true");

      fileName.textContent = payload.file.name;
      fileMeta.textContent =
        formatBytes(payload.file.size) +
        " · " + (payload.file.mimeType || "document") +
        " · Ready to add";
      fileIcon.textContent = labelForExtension(payload.file.extension);

      dropzone.hidden = true;
      result.hidden = false;
      if (window.DocumentPreview) {
        window.DocumentPreview.mount(previewBody, payload.preview);
      } else {
        previewBody.textContent = "Preview renderer could not be loaded.";
      }

      var oldToken = state.previous && state.previous.token;
      if (oldToken && oldToken !== payload.token) {
        fetch(removeBase + "/" + encodeURIComponent(oldToken), {
          method: "DELETE",
          headers: { "x-csrf-token": csrf, accept: "application/json" },
          credentials: "same-origin",
        }).catch(function () {});
      }
      state.previous = null;

      window.setTimeout(function () {
        if (!state.uploading) progress.hidden = true;
      }, 520);
      result.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    function startUpload(file) {
      if (state.uploading) return;
      hideError();
      var validationError = validate(file);
      if (validationError) {
        showError(validationError);
        state.file = null;
        return;
      }

      state.previous =
        state.token && state.preview && state.info
          ? {
              token: state.token,
              preview: state.preview,
              info: state.info,
            }
          : null;

      state.file = file;
      resetProgress();
      errorBox.hidden = true;
      result.hidden = true;
      dropzone.hidden = false;
      dropzone.classList.add("is-uploading");
      progress.hidden = false;
      progressName.textContent = file.name;
      progressPercent.textContent = "0%";
      progressStatus.textContent = "Preparing file…";
      updateStages("preparing", false);
      setBusy(true);

      var formData = new FormData();
      formData.append("file", file, file.name);
      var xhr = new XMLHttpRequest();
      state.xhr = xhr;
      xhr.open("POST", uploadUrl, true);
      xhr.setRequestHeader("x-csrf-token", csrf);
      xhr.setRequestHeader("Accept", "application/json");
      xhr.responseType = "json";
      xhr.withCredentials = true;

      xhr.upload.addEventListener("progress", function (event) {
        if (!state.uploading) return;
        if (event.lengthComputable && event.total) {
          var percent = Math.min(99, Math.floor((event.loaded / event.total) * 100));
          progressTrack.classList.remove("is-indeterminate");
          progressBar.style.width = percent + "%";
          progressPercent.textContent = percent + "%";
          progressStatus.textContent = "Uploading… " + percent + "%";
          updateStages("uploading", false);
        } else {
          progressTrack.classList.add("is-indeterminate");
          progressPercent.textContent = "—";
          progressStatus.textContent = "Uploading…";
          updateStages("uploading", false);
        }
      });

      xhr.upload.addEventListener("load", function () {
        if (!state.uploading) return;
        progressTrack.classList.add("is-indeterminate");
        progressStatus.textContent = "Processing document…";
        updateStages("processing", false);
        state.processingTimer = window.setTimeout(function () {
          if (!state.uploading) return;
          progressStatus.textContent = "Generating document preview…";
        }, 850);
      });

      xhr.addEventListener("load", function () {
        if (!state.uploading) return;
        var payload = xhr.response;
        if (!payload && xhr.responseText) {
          try {
            payload = JSON.parse(xhr.responseText);
          } catch (error) {
            payload = null;
          }
        }
        if (xhr.status >= 200 && xhr.status < 300 && payload && payload.preview) {
          handleSuccess(payload, file);
          return;
        }
        setBusy(false);
        dropzone.classList.remove("is-uploading");
        showError(
          (payload && payload.error) ||
            "The server could not process this document. Please try again."
        );
      });

      xhr.addEventListener("error", function () {
        if (!state.uploading) return;
        setBusy(false);
        dropzone.classList.remove("is-uploading");
        showError("The upload lost its connection. Check your network and retry.");
      });

      xhr.addEventListener("abort", function () {
        if (!state.uploading) return;
        setBusy(false);
        dropzone.classList.remove("is-uploading");
        showError("The upload was cancelled.");
      });

      window.setTimeout(function () {
        if (!state.uploading) return;
        progressStatus.textContent = "Uploading…";
        updateStages("uploading", false);
      }, 180);

      xhr.send(formData);
    }

    function removeUpload() {
      if (state.removing) return;
      if (state.uploading && state.xhr) {
        state.uploading = false;
        state.xhr.abort();
      }
      var token = state.token;
      state.removing = true;
      remove.disabled = true;

      var finish = function () {
        state.removing = false;
        remove.disabled = false;
        clearResult();
        resetProgress();
        hideError();
        state.file = null;
        state.previous = null;
        input.value = "";
        dropzone.hidden = false;
        dropzone.classList.remove("is-uploading");
        result.hidden = true;
        setBusy(false);
        input.focus();
      };

      if (!token) {
        finish();
        return;
      }

      fetch(removeBase + "/" + encodeURIComponent(token), {
        method: "DELETE",
        headers: { "x-csrf-token": csrf, accept: "application/json" },
        credentials: "same-origin",
      })
        .then(function (response) {
          if (!response.ok && response.status !== 404) {
            return response.json().then(function (payload) {
              throw new Error(payload.error || "The uploaded file could not be removed.");
            });
          }
          finish();
        })
        .catch(function (error) {
          remove.disabled = false;
          state.removing = false;
          showError(error.message || "The uploaded file could not be removed.");
        });
    }

    dropzone.addEventListener("click", function (event) {
      if (event.target.closest("[data-remove]")) return;
      input.click();
    });

    dropzone.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input.click();
      }
    });

    ["dragenter", "dragover"].forEach(function (type) {
      dropzone.addEventListener(type, function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (type === "dragenter") dragDepth += 1;
        dropzone.classList.add("is-dragging");
      });
    });

    dropzone.addEventListener("dragleave", function (event) {
      event.preventDefault();
      event.stopPropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dropzone.classList.remove("is-dragging");
    });

    dropzone.addEventListener("drop", function (event) {
      event.preventDefault();
      event.stopPropagation();
      dragDepth = 0;
      dropzone.classList.remove("is-dragging");
      var files = event.dataTransfer && event.dataTransfer.files;
      if (!files || !files.length) return;
      if (files.length > 1) {
        showError("Choose one source document per lesson.");
        return;
      }
      input.files = files;
      startUpload(files[0]);
    });

    input.addEventListener("change", function () {
      if (!input.files || !input.files.length) return;
      startUpload(input.files[0]);
    });

    retry.addEventListener("click", function () {
      if (state.file) startUpload(state.file);
    });

    remove.addEventListener("click", removeUpload);

    form.addEventListener("submit", function (event) {
      if (state.uploading || state.removing) {
        event.preventDefault();
        showError("Please wait for the current upload to finish.");
        return;
      }
      if (state.file && !state.token) {
        event.preventDefault();
        showError("The selected document has not uploaded yet. Retry the upload before saving.");
        return;
      }
    });

    // The viewer exposes its instance on the container so a replacement can
    // destroy the old PDF document before mounting the next one.
    var originalMount = window.DocumentPreview && window.DocumentPreview.mount;
    if (originalMount && !window.DocumentPreview.__wrapped) {
      window.DocumentPreview.mount = function (container, preview, options) {
        var instance = originalMount(container, preview, options);
        container.__viewer = instance;
        return instance;
      };
      window.DocumentPreview.__wrapped = true;
    }
  }

  function init() {
    document.querySelectorAll(".module-upload-form").forEach(initForm);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
