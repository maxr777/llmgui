import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.min.css";
import "katex/dist/katex.min.css";
import renderMathInElement from "katex/contrib/auto-render";
import { marked } from "marked";

type Provider = "openai" | "anthropic" | "google";
type Role = "user" | "assistant";

interface Attachment {
  name: string;
  content: string;
}

interface Message {
  role: Role;
  content: string;
  attachments?: Attachment[];
}

interface Conversation {
  id: string;
  title: string;
  starred: boolean;
  updatedAt: number;
  messages: Message[];
}

interface SystemPrompt {
  id: string;
  name: string;
  content: string;
}

interface AppState {
  version: 2;
  selectedProvider: Provider;
  selectedModel: string;
  selectedPromptId: string;
  models: Record<Provider, string>;
  prompts: SystemPrompt[];
  conversations: Conversation[];
  activeConversationId: string | null;
  temperature: string;
  topP: string;
  topK: string;
  thinking: string;
}

interface ChatResponse {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  stopReason?: string;
}

const STORAGE_KEY = "llmgui-state-v2";
const providers: Provider[] = ["openai", "anthropic", "google"];
const defaultState: AppState = {
  version: 2,
  selectedProvider: "openai",
  selectedModel: "gpt-4.1",
  selectedPromptId: "default",
  models: {
    openai: "gpt-4.1,gpt-4.1-mini",
    anthropic: "claude-sonnet-4-5,claude-haiku-4-5",
    google: "gemini-2.5-pro,gemini-2.5-flash",
  },
  prompts: [
    { id: "default", name: "Default Assistant", content: "You are a helpful assistant." },
    { id: "coding", name: "Coding Partner", content: "You are an expert software engineer. Provide concise, high-quality code." },
  ],
  conversations: [],
  activeConversationId: null,
  temperature: "1",
  topP: "",
  topK: "",
  thinking: "",
};

let state = loadState();
let pendingAttachments: Attachment[] = [];
const pendingConversations = new Set<string>();

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector);

function loadState(): AppState {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<AppState> | null;
    if (!saved || saved.version !== 2 || !saved.models || !Array.isArray(saved.prompts) || !Array.isArray(saved.conversations)) {
      return structuredClone(defaultState);
    }
    return { ...structuredClone(defaultState), ...saved, models: { ...defaultState.models, ...saved.models } };
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState(): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    showError("Could not save locally. The app's storage may be full.");
    return false;
  }
}

function activeConversation(): Conversation | undefined {
  return state.conversations.find((conversation) => conversation.id === state.activeConversationId);
}

function apiContent(message: Message): string {
  if (!message.attachments?.length) return message.content;
  const files = message.attachments.map((file) =>
    `\n\n<attachment name="${file.name.replace(/"/g, "&quot;")}">\n${file.content}\n</attachment>`,
  ).join("");
  return message.content + files;
}

function parseOptionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function updateModels() {
  const select = $("#setting-model-select") as HTMLSelectElement;
  const previous = `${state.selectedProvider}:${state.selectedModel}`;
  select.replaceChildren();
  for (const provider of providers) {
    const models = state.models[provider].split(",").map((model) => model.trim()).filter(Boolean);
    for (const model of models) {
      const option = document.createElement("option");
      option.value = `${provider}:${model}`;
      option.textContent = model;
      option.dataset.provider = provider;
      option.dataset.model = model;
      select.append(option);
    }
  }
  const matching = Array.from(select.options).find((option) => option.value === previous);
  if (matching) select.value = matching.value;
  else if (select.options.length) {
    const option = select.options[0];
    state.selectedProvider = option.dataset.provider as Provider;
    state.selectedModel = option.dataset.model || "";
  }
  updateStatus();
}

function updatePromptDropdown(preferred = state.selectedPromptId) {
  const select = $("#setting-prompt-select") as HTMLSelectElement;
  select.replaceChildren(new Option("None (Disabled)", "none"));
  for (const prompt of state.prompts) select.append(new Option(prompt.name, prompt.id));
  select.append(new Option("+ Add New", "new"));
  select.value = Array.from(select.options).some((option) => option.value === preferred) ? preferred : "none";
  loadSelectedPrompt();
}

function loadSelectedPrompt() {
  const select = $("#setting-prompt-select") as HTMLSelectElement;
  const name = $("#setting-prompt-name") as HTMLInputElement;
  const content = $("#setting-system") as HTMLTextAreaElement;
  const save = $("#btn-prompt-save") as HTMLButtonElement;
  const remove = $("#btn-prompt-delete") as HTMLButtonElement;
  const prompt = state.prompts.find((item) => item.id === select.value);

  if (select.value === "new") {
    name.value = "";
    content.value = "";
  } else if (prompt) {
    name.value = prompt.name;
    content.value = prompt.content;
    state.selectedPromptId = prompt.id;
    saveState();
  } else {
    name.value = "Disabled";
    content.value = "";
    state.selectedPromptId = "none";
    saveState();
  }
  const disabled = select.value === "none";
  name.disabled = disabled;
  content.disabled = disabled;
  save.style.display = disabled ? "none" : "block";
  remove.style.display = prompt ? "block" : "none";
  updateStatus();
}

function updateStatus(tokens?: number) {
  $("#status-model-name")!.textContent = state.selectedModel || "none";
  const prompt = state.prompts.find((item) => item.id === state.selectedPromptId);
  $("#status-prompt-name")!.textContent = prompt?.name.toLowerCase() || "none";
  if (tokens !== undefined) $("#status-tokens")!.textContent = String(tokens);
}

function createIconButton(className: string, title: string, svg: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `history-action-btn ${className}`;
  button.title = title;
  button.type = "button";
  button.innerHTML = svg;
  return button;
}

function createHistoryItem(conversation: Conversation): HTMLElement {
  const item = document.createElement("div");
  item.className = `history-item ${conversation.id === state.activeConversationId ? "active" : ""}`;
  const title = document.createElement("span");
  title.className = "history-title";
  title.textContent = conversation.title;
  const actions = document.createElement("div");
  actions.className = "history-actions";
  const star = createIconButton(
    `star ${conversation.starred ? "active" : ""}`,
    conversation.starred ? "Unstar" : "Star",
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="${conversation.starred ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  );
  const rename = createIconButton("rename", "Rename", `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"/></svg>`);
  const remove = createIconButton("delete", "Delete", `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 1 1 1 2v2"/></svg>`);
  actions.append(star, rename, remove);
  item.append(title, actions);

  item.addEventListener("click", () => selectConversation(conversation.id));
  star.addEventListener("click", (event) => {
    event.stopPropagation();
    conversation.starred = !conversation.starred;
    saveState();
    renderHistory();
  });
  rename.addEventListener("click", (event) => {
    event.stopPropagation();
    const next = window.prompt("Rename to:", conversation.title)?.trim();
    if (next) {
      conversation.title = next.slice(0, 100);
      saveState();
      renderHistory();
    }
  });
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!window.confirm("Delete this chat?")) return;
    state.conversations = state.conversations.filter((item) => item.id !== conversation.id);
    if (state.activeConversationId === conversation.id) {
      state.activeConversationId = null;
      clearComposer();
    }
    saveState();
    renderHistory();
    renderConversation();
  });
  return item;
}

function renderHistory() {
  const list = $("#history-list")!;
  list.replaceChildren();
  const sorted = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const sections: [string, Conversation[]][] = [
    ["Starred", sorted.filter((item) => item.starred)],
    ["Recent", sorted.filter((item) => !item.starred)],
  ];
  let first = true;
  for (const [label, conversations] of sections) {
    if (!conversations.length) continue;
    const header = document.createElement("div");
    header.className = `history-section-header ${first ? "first" : ""}`;
    header.textContent = label;
    list.append(header, ...conversations.map(createHistoryItem));
    first = false;
  }
}

function renderAssistantContent(element: HTMLElement, content: string) {
  const rendered = marked.parse(content, { async: false }) as string;
  element.innerHTML = DOMPurify.sanitize(rendered, {
    FORBID_TAGS: ["form", "iframe", "object", "embed", "style", "img"],
    FORBID_ATTR: ["style"],
  });
  renderMathInElement(element, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "$", right: "$", display: false },
    ],
    throwOnError: false,
  });
  element.querySelectorAll<HTMLElement>("pre code").forEach((block) => hljs.highlightElement(block));
  element.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });
}

function messageElement(message: Message): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${message.role === "assistant" ? "ai" : "user"}`;
  const content = document.createElement("div");
  content.className = "message-content";
  if (message.role === "assistant") renderAssistantContent(content, message.content);
  else content.textContent = message.content;
  wrapper.append(content);
  if (message.attachments?.length) {
    const attachments = document.createElement("div");
    attachments.className = "message-attachments";
    attachments.textContent = message.attachments.map((file) => file.name).join(", ");
    wrapper.append(attachments);
  }
  return wrapper;
}

function renderConversation() {
  const feed = $("#chat-feed")!;
  const conversation = activeConversation();
  feed.replaceChildren(...(conversation?.messages.map(messageElement) || []));
  feed.scrollTop = feed.scrollHeight;
  updatePendingUi();
}

function selectConversation(id: string) {
  if (state.activeConversationId !== id) clearComposer();
  state.activeConversationId = id;
  saveState();
  renderHistory();
  renderConversation();
  $("#history-panel")?.classList.remove("open");
}

function newConversation() {
  state.activeConversationId = null;
  clearComposer();
  saveState();
  renderHistory();
  renderConversation();
  renderPendingAttachments();
  $("#history-panel")?.classList.remove("open");
  ($("#chat-input") as HTMLTextAreaElement).focus();
}

function clearComposer() {
  const input = $("#chat-input") as HTMLTextAreaElement | null;
  if (input) {
    input.value = "";
    input.style.height = "26px";
  }
  pendingAttachments = [];
  if ($("#attachment-list")) renderPendingAttachments();
}

function showError(message: string) {
  const wrapper = document.createElement("div");
  wrapper.className = "message ai error";
  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent = message;
  wrapper.append(content);
  $("#chat-feed")?.append(wrapper);
}

function updatePendingUi() {
  const pending = state.activeConversationId ? pendingConversations.has(state.activeConversationId) : false;
  ($("#send-btn") as HTMLButtonElement).disabled = pending;
}

async function sendMessage() {
  const input = $("#chat-input") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text || !state.selectedModel) return;
  const key = ($(`#key-${state.selectedProvider}`) as HTMLInputElement).value.trim();
  if (!key) {
    $("#settings-overlay")?.classList.add("open");
    ($(`#key-${state.selectedProvider}`) as HTMLInputElement).focus();
    showError(`Enter an ${state.selectedProvider} API key in Settings.`);
    return;
  }

  let conversation = activeConversation();
  if (!conversation) {
    conversation = {
      id: crypto.randomUUID(),
      title: text.replace(/\s+/g, " ").slice(0, 55),
      starred: false,
      updatedAt: Date.now(),
      messages: [],
    };
    state.conversations.unshift(conversation);
    state.activeConversationId = conversation.id;
  }
  if (pendingConversations.has(conversation.id)) return;

  const userMessage: Message = {
    role: "user",
    content: text,
    attachments: pendingAttachments.length ? pendingAttachments : undefined,
  };
  conversation.messages.push(userMessage);
  conversation.updatedAt = Date.now();
  const conversationId = conversation.id;
  const messages = conversation.messages.map((message) => ({ role: message.role, content: apiContent(message) }));
  const system = state.prompts.find((prompt) => prompt.id === state.selectedPromptId)?.content;
  pendingConversations.add(conversationId);
  pendingAttachments = [];
  input.value = "";
  input.style.height = "26px";
  saveState();
  renderPendingAttachments();
  renderHistory();
  renderConversation();

  try {
    const response = await invoke<ChatResponse>("chat", {
      request: {
        provider: state.selectedProvider,
        model: state.selectedModel,
        apiKey: key,
        system,
        messages,
        temperature: parseOptionalNumber(state.temperature),
        topP: parseOptionalNumber(state.topP),
        topK: parseOptionalNumber(state.topK),
        thinking: state.thinking.trim() || undefined,
      },
    });
    const target = state.conversations.find((item) => item.id === conversationId);
    if (target) {
      target.messages.push({ role: "assistant", content: response.content });
      target.updatedAt = Date.now();
      saveState();
      renderHistory();
      if (state.activeConversationId === conversationId) {
        renderConversation();
        updateStatus(response.totalTokens ?? ((response.inputTokens || 0) + (response.outputTokens || 0)));
      }
    }
  } catch (error) {
    if (state.activeConversationId === conversationId) showError(String(error));
  } finally {
    pendingConversations.delete(conversationId);
    updatePendingUi();
  }
}

function renderPendingAttachments() {
  const list = $("#attachment-list")!;
  list.replaceChildren();
  for (const [index, file] of pendingAttachments.entries()) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "attachment-chip";
    item.title = "Remove attachment";
    item.textContent = `${file.name} ×`;
    item.addEventListener("click", () => {
      pendingAttachments.splice(index, 1);
      renderPendingAttachments();
    });
    list.append(item);
  }
}

async function addAttachments(files: FileList | null) {
  if (!files) return;
  let aggregate = pendingAttachments.reduce((total, file) => total + new TextEncoder().encode(file.content).length, 0);
  for (const file of Array.from(files)) {
    if (file.size > 256 * 1024) {
      showError(`${file.name} is larger than the 256 KiB attachment limit.`);
      continue;
    }
    const content = await file.text();
    const bytes = new TextEncoder().encode(content).length;
    if (content.includes("\0") || aggregate + bytes > 512 * 1024) {
      showError(`${file.name} is not a text file or exceeds the 512 KiB total limit.`);
      continue;
    }
    pendingAttachments.push({ name: file.name.slice(0, 255), content });
    aggregate += bytes;
  }
  renderPendingAttachments();
}

function bindSettings() {
  for (const provider of providers) {
    const models = $(`#models-${provider}`) as HTMLInputElement;
    models.value = state.models[provider];
    models.addEventListener("input", () => {
      state.models[provider] = models.value;
      updateModels();
      saveState();
    });
  }
  const fields: [string, keyof Pick<AppState, "temperature" | "topP" | "topK" | "thinking">][] = [
    ["#setting-temp", "temperature"],
    ["#setting-topp", "topP"],
    ["#setting-topk", "topK"],
    ["#setting-thinking", "thinking"],
  ];
  for (const [selector, property] of fields) {
    const input = $(selector) as HTMLInputElement;
    input.value = state[property];
    input.addEventListener("change", () => {
      state[property] = input.value;
      saveState();
    });
  }
  const modelSelect = $("#setting-model-select") as HTMLSelectElement;
  modelSelect.addEventListener("change", () => {
    const option = modelSelect.selectedOptions[0];
    state.selectedProvider = option.dataset.provider as Provider;
    state.selectedModel = option.dataset.model || "";
    saveState();
    updateStatus();
  });
  $("#setting-prompt-select")?.addEventListener("change", loadSelectedPrompt);
  $("#btn-prompt-save")?.addEventListener("click", () => {
    const select = $("#setting-prompt-select") as HTMLSelectElement;
    const name = ($("#setting-prompt-name") as HTMLInputElement).value.trim() || "Untitled";
    const content = ($("#setting-system") as HTMLTextAreaElement).value;
    let id = select.value;
    if (id === "new") {
      id = crypto.randomUUID();
      state.prompts.push({ id, name, content });
    } else {
      const prompt = state.prompts.find((item) => item.id === id);
      if (prompt) Object.assign(prompt, { name, content });
    }
    state.selectedPromptId = id;
    saveState();
    updatePromptDropdown(id);
  });
  $("#btn-prompt-delete")?.addEventListener("click", () => {
    const select = $("#setting-prompt-select") as HTMLSelectElement;
    state.prompts = state.prompts.filter((prompt) => prompt.id !== select.value);
    state.selectedPromptId = "none";
    saveState();
    updatePromptDropdown("none");
  });
}

window.addEventListener("DOMContentLoaded", () => {
  bindSettings();
  updateModels();
  updatePromptDropdown();
  renderHistory();
  renderConversation();

  $("#chat-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage();
  });
  const input = $("#chat-input") as HTMLTextAreaElement;
  input.addEventListener("input", () => {
    input.style.height = "26px";
    input.style.height = `${Math.max(26, input.scrollHeight)}px`;
    $("#chat-form")?.classList.toggle("multi-line", input.scrollHeight > 26);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  });
  $("#history-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    $("#history-panel")?.classList.toggle("open");
  });
  $("#settings-btn")?.addEventListener("click", () => $("#settings-overlay")?.classList.add("open"));
  $("#new-chat-btn-main")?.addEventListener("click", newConversation);
  $("#attach-btn")?.addEventListener("click", () => ($("#attachment-input") as HTMLInputElement).click());
  $("#attachment-input")?.addEventListener("change", async (event) => {
    const fileInput = event.target as HTMLInputElement;
    await addAttachments(fileInput.files);
    fileInput.value = "";
  });
  document.querySelectorAll<HTMLButtonElement>(".toggle-key").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.target!) as HTMLInputElement;
      input.type = input.type === "password" ? "text" : "password";
    });
  });
  document.addEventListener("click", (event) => {
    const target = event.target as Node;
    const history = $("#history-panel");
    if (history?.classList.contains("open") && !history.contains(target)) history.classList.remove("open");
    if (target === $("#settings-overlay")) $("#settings-overlay")?.classList.remove("open");
  });
});
