import { invoke } from "@tauri-apps/api/core";

// Define Global types for the external libraries
declare const marked: any;
declare const renderMathInElement: any;
declare const hljs: any;

let chatInputEl: HTMLTextAreaElement | null;
let chatFeedEl: HTMLElement | null;
let chatFormEl: HTMLFormElement | null;
let sendBtnEl: HTMLButtonElement | null;
let statusTokensEl: HTMLElement | null;
let statusModelNameEl: HTMLElement | null;
let settingModelSelectEl: HTMLSelectElement | null;
let historyListEl: HTMLElement | null;

// UI Panels
let historyPanel: HTMLElement | null;
let settingsOverlay: HTMLElement | null;

// System Prompt Management
let promptSelectEl: HTMLSelectElement | null;
let promptNameEl: HTMLInputElement | null;
let promptSystemEl: HTMLTextAreaElement | null;

let systemPrompts = [
  { id: "default", name: "Default Assistant", content: "You are a helpful assistant." },
  { id: "coding", name: "Coding Partner", content: "You are an expert software engineer. Provide concise, high-quality code." }
];

function updatePromptDropdown() {
  if (!promptSelectEl) return;
  const currentId = promptSelectEl.value;
  promptSelectEl.innerHTML = "";
  
  // Permanent None option
  const noneOpt = document.createElement("option");
  noneOpt.value = "none";
  noneOpt.textContent = "None (Disabled)";
  promptSelectEl.appendChild(noneOpt);

  systemPrompts.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    promptSelectEl?.appendChild(opt);
  });

  const newOpt = document.createElement("option");
  newOpt.value = "new";
  newOpt.textContent = "+ Add New";
  promptSelectEl.appendChild(newOpt);
  
  if (currentId) promptSelectEl.value = currentId;
}

function loadSelectedPrompt() {
  if (!promptSelectEl || !promptNameEl || !promptSystemEl) return;
  const id = promptSelectEl.value;
  const deleteBtn = document.querySelector("#btn-prompt-delete") as HTMLButtonElement;
  const saveBtn = document.querySelector("#btn-prompt-save") as HTMLButtonElement;
  const statusPromptEl = document.querySelector("#status-prompt-name");

  if (id === "new") {
    promptNameEl.value = "";
    promptSystemEl.value = "";
    promptNameEl.disabled = false;
    promptSystemEl.disabled = false;
    if (deleteBtn) deleteBtn.style.display = "none";
    if (saveBtn) saveBtn.style.display = "block";
    if (statusPromptEl) statusPromptEl.textContent = "new";
  } else if (id === "none") {
    promptNameEl.value = "Disabled";
    promptSystemEl.value = "";
    promptNameEl.disabled = true;
    promptSystemEl.disabled = true;
    if (deleteBtn) deleteBtn.style.display = "none";
    if (saveBtn) saveBtn.style.display = "none";
    if (statusPromptEl) statusPromptEl.textContent = "none";
  } else {
    const p = systemPrompts.find(x => x.id === id);
    if (p) {
      promptNameEl.value = p.name;
      promptSystemEl.value = p.content;
      promptNameEl.disabled = false;
      promptSystemEl.disabled = false;
      if (deleteBtn) deleteBtn.style.display = "block";
      if (saveBtn) saveBtn.style.display = "block";
      if (statusPromptEl) statusPromptEl.textContent = p.name.toLowerCase();
    }
  }
}

// Mock history data
let historyData = [
  { id: 1, title: "Current Conversation", active: true, starred: false },
  { id: 2, title: "Project Architecture Ideas", active: false, starred: true },
  { id: 3, title: "Rust Backend Implementation", active: false, starred: false },
  { id: 4, title: "Minimalist CSS Tricks", active: false, starred: true }
];

function createHistoryItem(item: any) {
  const div = document.createElement("div");
  div.className = `history-item ${item.active ? 'active' : ''}`;
  div.innerHTML = `
    <span class="history-title">${item.title}</span>
    <div class="history-actions">
      <button class="history-action-btn star ${item.starred ? 'active' : ''}" title="${item.starred ? 'Unstar' : 'Star'}">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="${item.starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      </button>
      <button class="history-action-btn rename" title="Rename">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"/></svg>
      </button>
      <button class="history-action-btn delete" title="Delete">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
      </button>
    </div>
  `;
  div.addEventListener("click", () => {
    historyData.forEach(h => h.active = (h.id === item.id));
    renderHistory();
  });
  div.querySelector(".star")?.addEventListener("click", (e) => {
    e.stopPropagation();
    item.starred = !item.starred;
    renderHistory();
  });
  div.querySelector(".rename")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const newTitle = prompt("Rename to:", item.title);
    if (newTitle) { item.title = newTitle; renderHistory(); }
  });
  div.querySelector(".delete")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (confirm("Delete this chat?")) {
      historyData = historyData.filter(h => h.id !== item.id);
      renderHistory();
    }
  });
  return div;
}

function renderHistory() {
  if (!historyListEl) return;
  historyListEl.innerHTML = "";
  const starred = historyData.filter(h => h.starred);
  const recent = historyData.filter(h => !h.starred);
  if (starred.length > 0) {
    const header = document.createElement("div");
    header.className = "history-section-header first";
    header.textContent = "Starred";
    historyListEl.appendChild(header);
    starred.forEach(item => historyListEl?.appendChild(createHistoryItem(item)));
  }
  if (recent.length > 0) {
    const header = document.createElement("div");
    header.className = `history-section-header ${starred.length === 0 ? 'first' : ''}`;
    header.textContent = "Recent";
    historyListEl.appendChild(header);
    recent.forEach(item => historyListEl?.appendChild(createHistoryItem(item)));
  }
}

function updateTokenCount(tokens: number) {
  if (statusTokensEl) statusTokensEl.textContent = `${tokens}`;
}

function updateModelDropdown() {
  if (!settingModelSelectEl) return;
  const currentModel = settingModelSelectEl.value;
  settingModelSelectEl.innerHTML = "";
  ["openai", "anthropic", "google"].forEach(provider => {
    const input = document.querySelector(`#models-${provider}`) as HTMLInputElement;
    if (input && input.value) {
      input.value.split(",").forEach(model => {
        const m = model.trim();
        if (m) {
          const option = document.createElement("option");
          option.value = m;
          option.textContent = m;
          settingModelSelectEl?.appendChild(option);
        }
      });
    }
  });
  if (currentModel && Array.from(settingModelSelectEl.options).some(o => o.value === currentModel)) {
    settingModelSelectEl.value = currentModel;
  }
  updateStatusModelName();
}

function updateStatusModelName() {
  if (statusModelNameEl && settingModelSelectEl) {
    statusModelNameEl.textContent = settingModelSelectEl.value || "none";
  }
}

function renderContent(content: string): string {
  marked.setOptions({
    highlight: function(code: string, lang: string) {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
      return hljs.highlightAuto(code).value;
    }
  });
  return marked.parse(content);
}

function appendMessage(role: "user" | "ai", content: string) {
  if (!chatFeedEl) return;
  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${role}`;
  const contentDiv = document.createElement("div");
  contentDiv.className = "message-content";
  if (role === "ai") {
    contentDiv.innerHTML = renderContent(content);
    setTimeout(() => {
      renderMathInElement(contentDiv, {
        delimiters: [{left: '$$', right: '$$', display: true}, {left: '$', right: '$', display: false}],
        throwOnError : false
      });
      contentDiv.querySelectorAll('pre code').forEach((block: any) => hljs.highlightElement(block));
    }, 0);
  } else {
    contentDiv.textContent = content;
  }
  messageDiv.appendChild(contentDiv);
  chatFeedEl.appendChild(messageDiv);
  chatFeedEl.scrollTop = chatFeedEl.scrollHeight;
}

async function sendMessage() {
  if (!chatInputEl || !chatInputEl.value.trim() || !sendBtnEl) return;
  const prompt = chatInputEl.value.trim();
  appendMessage("user", prompt);
  updateTokenCount(Math.ceil(prompt.length / 4));
  chatInputEl.value = "";
  chatInputEl.style.height = "26px";
  sendBtnEl.disabled = true;
  try {
    const response: string = await invoke("chat", { prompt });
    appendMessage("ai", response);
    updateTokenCount(Math.ceil((prompt.length + response.length) / 4));
  } catch (error) {
    appendMessage("ai", "Error: Failed to get response.");
  } finally {
    sendBtnEl.disabled = false;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  chatInputEl = document.querySelector("#chat-input");
  chatFeedEl = document.querySelector("#chat-feed");
  chatFormEl = document.querySelector("#chat-form");
  sendBtnEl = document.querySelector("#send-btn");
  statusTokensEl = document.querySelector("#status-tokens");
  statusModelNameEl = document.querySelector("#status-model-name");
  settingModelSelectEl = document.querySelector("#setting-model-select");
  historyListEl = document.querySelector("#history-list");
  historyPanel = document.querySelector("#history-panel");
  settingsOverlay = document.querySelector("#settings-overlay");
  
  promptSelectEl = document.querySelector("#setting-prompt-select");
  promptNameEl = document.querySelector("#setting-prompt-name");
  promptSystemEl = document.querySelector("#setting-system");

  updateModelDropdown();
  updatePromptDropdown();
  loadSelectedPrompt();
  renderHistory();

  chatFormEl?.addEventListener("submit", (e) => { e.preventDefault(); sendMessage(); });

  chatInputEl?.addEventListener("input", () => {
    if (chatInputEl && chatFormEl) {
      chatInputEl.style.height = "26px";
      const newHeight = chatInputEl.scrollHeight;
      chatInputEl.style.height = (newHeight > 26 ? newHeight : 26) + "px";
      chatFormEl.classList.toggle("multi-line", newHeight > 26);
    }
  });

  chatInputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  document.querySelector("#history-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    historyPanel?.classList.toggle("open");
  });

  document.querySelector("#settings-btn")?.addEventListener("click", () => settingsOverlay?.classList.add("open"));

  document.querySelector("#new-chat-btn-main")?.addEventListener("click", () => {
    if (chatFeedEl) chatFeedEl.innerHTML = "";
    historyPanel?.classList.remove("open");
  });

  ["openai", "anthropic", "google"].forEach(provider => {
    document.querySelector(`#models-${provider}`)?.addEventListener("input", updateModelDropdown);
  });

  settingModelSelectEl?.addEventListener("change", updateStatusModelName);
  
  // Prompt Actions
  promptSelectEl?.addEventListener("change", loadSelectedPrompt);
  
  document.querySelector("#btn-prompt-save")?.addEventListener("click", () => {
    const id = promptSelectEl?.value;
    const name = promptNameEl?.value || "Untitled";
    const content = promptSystemEl?.value || "";
    if (id === "new" || id === "none") {
      const newId = Date.now().toString();
      systemPrompts.push({ id: newId, name, content });
      updatePromptDropdown();
      if (promptSelectEl) promptSelectEl.value = newId;
      loadSelectedPrompt();
    } else {
      const p = systemPrompts.find(x => x.id === id);
      if (p) { p.name = name; p.content = content; updatePromptDropdown(); }
    }
  });

  document.querySelector("#btn-prompt-delete")?.addEventListener("click", () => {
    const id = promptSelectEl?.value;
    if (id && id !== "new" && id !== "none") {
      systemPrompts = systemPrompts.filter(x => x.id !== id);
      updatePromptDropdown();
      if (promptSelectEl) {
        promptSelectEl.value = "none";
      }
      loadSelectedPrompt();
    }
  });

  // Toggle API Keys
  document.querySelectorAll(".toggle-key").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-target");
      const input = document.getElementById(targetId!) as HTMLInputElement;
      if (input.type === "password") {
        input.type = "text";
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`;
      } else {
        input.type = "password";
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="eye-icon"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0z"/><circle cx="12" cy="12" r="3"/></svg>`;
      }
    });
  });

  // Cap number inputs to 1 decimal place
  document.querySelectorAll('input[type="number"]').forEach(input => {
    input.addEventListener("blur", (e) => {
      const target = e.target as HTMLInputElement;
      if (target.id === "setting-temp" || target.id === "setting-topp") {
        const val = parseFloat(target.value);
        if (!isNaN(val)) { target.value = val.toFixed(1); }
      }
    });
  });

  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (historyPanel?.classList.contains("open") && !historyPanel.contains(target)) historyPanel.classList.remove("open");
    if (target === settingsOverlay) settingsOverlay?.classList.remove("open");
  });
});
