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

interface ApiKeyStatus {
  saved: boolean;
  error?: string;
}

type ApiKeyStatuses = Record<Provider, ApiKeyStatus>;

const STORAGE_KEY = "llmgui-state-v2";
const providers: Provider[] = ["openai", "anthropic", "google"];
const defaultState: AppState = {
  version: 2,
  selectedProvider: "openai",
  selectedModel: "gpt-5.6-terra",
  selectedPromptId: "default",
  models: {
    openai: "gpt-5.6-terra,gpt-5.6-luna",
    anthropic: "claude-sonnet-5,claude-haiku-4-5",
    google: "gemini-3.5-flash,gemini-3.1-flash-lite",
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
const apiKeySaved: Record<Provider, boolean> = { openai: false, anthropic: false, google: false };
const apiKeyRevisions: Record<Provider, number> = { openai: 0, anthropic: 0, google: 0 };
const apiKeySaveChains: Record<Provider, Promise<void>> = {
  openai: Promise.resolve(),
  anthropic: Promise.resolve(),
  google: Promise.resolve(),
};
let apiKeysLoaded: Promise<void> = Promise.resolve();

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector);

function loadState(): AppState {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<AppState> | null;
    if (!saved || saved.version !== 2 || !saved.models || !Array.isArray(saved.prompts) || !Array.isArray(saved.conversations)) {
      return structuredClone(defaultState);
    }
    return {
      ...structuredClone(defaultState),
      ...saved,
      models: { ...defaultState.models, ...saved.models },
      activeConversationId: null,
    };
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

async function testCredentials(provider: Provider, button: HTMLButtonElement) {
  const keyInput = $(`#key-${provider}`) as HTMLInputElement;
  const status = $(`#test-status-${provider}`) as HTMLSpanElement;
  const apiKey = keyInput.value.trim();
  const revision = apiKeyRevisions[provider];
  status.className = "provider-test-status";
  status.textContent = "";
  status.title = "";

  button.disabled = true;
  button.textContent = "Testing…";
  try {
    if (apiKey) await saveEnteredApiKey(provider);
    else await apiKeySaveChains[provider];
    if (apiKeyRevisions[provider] !== revision) return;
    if (!apiKeySaved[provider]) {
      status.classList.add("failure");
      status.textContent = "×";
      status.title = "Enter an API key first.";
      keyInput.focus();
      return;
    }
    await invoke("test_credentials", { request: { provider } });
    if (apiKeyRevisions[provider] !== revision) return;
    status.classList.add("success");
    status.textContent = "✓";
    status.title = "Saved API key accepted for model listing. Chat access may still depend on model permissions and billing.";
  } catch (error) {
    if (apiKeyRevisions[provider] !== revision) return;
    status.classList.add("failure");
    status.textContent = "×";
    status.title = String(error);
  } finally {
    if (status.title) status.setAttribute("aria-label", status.title);
    else status.removeAttribute("aria-label");
    button.disabled = false;
    button.textContent = "Test";
  }
}

function updateApiKeyUi(provider: Provider, status: ApiKeyStatus) {
  const input = $(`#key-${provider}`) as HTMLInputElement;
  const indicator = $(`#test-status-${provider}`) as HTMLSpanElement;
  apiKeySaved[provider] = status.saved;
  input.placeholder = status.saved ? "Saved securely — enter replacement" : "API Key (saved securely)";
  if (status.error) {
    indicator.className = "provider-test-status failure";
    indicator.textContent = "×";
    indicator.title = status.error;
    indicator.setAttribute("aria-label", status.error);
  }
}

async function loadApiKeyStatuses() {
  try {
    const revisions = { ...apiKeyRevisions };
    const statuses = await invoke<ApiKeyStatuses>("load_api_key_statuses");
    for (const provider of providers) {
      if (apiKeyRevisions[provider] === revisions[provider]) updateApiKeyUi(provider, statuses[provider]);
    }
  } catch (error) {
    for (const provider of providers) {
      const status = $(`#test-status-${provider}`) as HTMLSpanElement;
      status.classList.add("failure");
      status.textContent = "×";
      status.title = String(error);
      status.setAttribute("aria-label", status.title);
    }
  }
}

function saveEnteredApiKey(provider: Provider): Promise<void> {
  const input = $(`#key-${provider}`) as HTMLInputElement;
  const apiKey = input.value.trim();
  if (!apiKey) return apiKeySaveChains[provider];
  return queueApiKeySave(provider, apiKey, true);
}

function queueApiKeySave(provider: Provider, apiKey: string, saved: boolean): Promise<void> {
  const revision = apiKeyRevisions[provider];
  const input = $(`#key-${provider}`) as HTMLInputElement;
  const status = $(`#test-status-${provider}`) as HTMLSpanElement;
  const save = apiKeySaveChains[provider]
    .catch(() => undefined)
    .then(() => invoke("save_api_key", { provider, apiKey }))
    .then(() => {
      apiKeySaved[provider] = saved;
      if (apiKeyRevisions[provider] !== revision) return;
      input.value = "";
      updateApiKeyUi(provider, { saved });
      status.className = "provider-test-status success";
      status.textContent = "✓";
      status.title = saved ? "API key saved securely." : "Saved API key deleted.";
      status.setAttribute("aria-label", status.title);
    })
    .catch((error) => {
      if (apiKeyRevisions[provider] === revision) {
        status.className = "provider-test-status failure";
        status.textContent = "×";
        status.title = String(error);
        status.setAttribute("aria-label", status.title);
      }
      throw error;
    });
  apiKeySaveChains[provider] = save;
  return save;
}

async function saveVisibleApiKeys(): Promise<boolean> {
  providers
    .filter((provider) => ($(`#key-${provider}`) as HTMLInputElement).value.trim())
    .forEach((provider) => void saveEnteredApiKey(provider));
  try {
    await Promise.all(providers.map((provider) => apiKeySaveChains[provider]));
    return true;
  } catch {
    return false;
  }
}

async function sendMessage() {
  const input = $("#chat-input") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text || !state.selectedModel) return;
  const provider = state.selectedProvider;
  const model = state.selectedModel;
  await apiKeysLoaded;
  if (($(`#key-${provider}`) as HTMLInputElement).value.trim()) {
    try {
      await saveEnteredApiKey(provider);
    } catch {
      return;
    }
  }
  try {
    await apiKeySaveChains[provider];
  } catch {
    return;
  }
  if (!apiKeySaved[provider]) {
    $("#settings-overlay")?.classList.add("open");
    ($(`#key-${provider}`) as HTMLInputElement).focus();
    showError(`Enter ${provider} API key in Settings.`);
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
        provider,
        model,
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
    const key = $(`#key-${provider}`) as HTMLInputElement;
    const test = $(`.provider-test[data-provider="${provider}"]`) as HTMLButtonElement;
    const save = $(`.provider-save[data-provider="${provider}"]`) as HTMLButtonElement;
    const clear = $(`.provider-clear[data-provider="${provider}"]`) as HTMLButtonElement;
    const testStatus = $(`#test-status-${provider}`) as HTMLSpanElement;
    models.value = state.models[provider];
    models.addEventListener("input", () => {
      state.models[provider] = models.value;
      updateModels();
      saveState();
    });
    key.addEventListener("input", () => {
      apiKeyRevisions[provider]++;
      testStatus.className = "provider-test-status";
      testStatus.textContent = "";
      testStatus.title = "";
      testStatus.removeAttribute("aria-label");
    });
    save.addEventListener("click", () => void saveEnteredApiKey(provider).catch(() => undefined));
    clear.addEventListener("click", () => {
      apiKeyRevisions[provider]++;
      key.value = "";
      void queueApiKeySave(provider, "", false).catch(() => undefined);
    });
    test.addEventListener("click", () => void testCredentials(provider, test));
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
  apiKeysLoaded = loadApiKeyStatuses();
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
  document.addEventListener("click", async (event) => {
    const target = event.target as Node;
    const history = $("#history-panel");
    if (history?.classList.contains("open") && !history.contains(target)) history.classList.remove("open");
    if (target === $("#settings-overlay") && await saveVisibleApiKeys()) {
      $("#settings-overlay")?.classList.remove("open");
    }
  });
});
