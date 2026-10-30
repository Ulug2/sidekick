// Chat history: saving and loading chats, the history drawer, pinned notes, and end-of-chat
// learning (reflection).
import { readLocal, type Chat, type ChatIndexEntry } from "../../core/storage/schema.js";
import { chat, MAX_CHATS, startNewChat, openChat } from "./sidepanel.js";
import { FAST_ONLY } from "../../assistant/routing.js";
import { getSettings } from "../../core/llm/ai.js";
import { getProfile } from "../../assistant/profile-core.js";
import { updateSessionNotes, reflectOnChat } from "../../assistant/session.js";
import { showToast } from "./messages.js";
import { ICON } from "./icons.js";
import { $ } from "../shared/dom.js";

// ---------- chat storage ----------
// Chats live in chrome.storage.local: an index ("chatIndex") plus one key per chat.

export function newChat(): Chat {
  const now = Date.now();
  return { id: crypto.randomUUID(), title: "", createdAt: now, updatedAt: now, messages: [] };
}

export async function loadIndex(): Promise<ChatIndexEntry[]> {
  const { chatIndex = [] } = await readLocal("chatIndex");
  return chatIndex;
}

export async function saveChat(c = chat) {
  if (!c.messages.length) return;
  c.updatedAt = Date.now();
  if (!c.title) {
    const first = c.messages.find(m => (m as any).role === "user");
    c.title = ((first as any)?.display?.prompt || "New chat").replace(/\s+/g, " ").slice(0, 60);
  }
  let index = (await loadIndex()).filter((x: any) => x.id !== c.id);
  index.unshift({ id: c.id, title: c.title, updatedAt: c.updatedAt });
  const dropped = index.slice(MAX_CHATS);
  index = index.slice(0, MAX_CHATS);
  await chrome.storage.local.set({ chatIndex: index, ["chat:" + c.id]: c });
  if (dropped.length) await chrome.storage.local.remove(dropped.map((x: any) => "chat:" + x.id));
  if (drawerOpen) renderChatList();
}

// Updates a stored chat's fields without moving it in the history list.
export async function patchStoredChat(id: any, fields: any) {
  const key = "chat:" + id;
  const data = await chrome.storage.local.get(key);
  if (data[key]) await chrome.storage.local.set({ [key]: { ...data[key], ...fields } });
}

// ---------- session memory ----------
// Pinned notes are refreshed in the background after each reply (one cheap call), and the
// next message waits for them, so instructions are never missed.

export const notesPending = new Map(); // chat id → promise

export function refreshNotes(c: any, userMsg: any, replyText: any) {
  const prompt = userMsg?.display?.prompt || userMsg?.text || "";
  if (!prompt.trim() || FAST_ONLY.test(prompt.trim())) return;
  const prev = notesPending.get(c.id) || Promise.resolve();
  const p = prev.then(async () => {
    const s = await getSettings();
    const profile = await getProfile();
    const userName = (profile.preferredName || profile.fullName || "").split(/\s+/)[0] || "the user";
    try {
      c.notes = await updateSessionNotes({ notes: c.notes || [], userText: userMsg.text, replyText, userName });
      if (c === chat) renderPin();
      if (c.messages.length) {
        if (c === chat) await saveChat(c);
        else await patchStoredChat(c.id, { notes: c.notes });
      }
    } catch (err: any) {
      console.warn("Couldn't update pinned notes", err);
    }
  });
  notesPending.set(c.id, p);
  p.finally(() => { if (notesPending.get(c.id) === p) notesPending.delete(c.id); });
}

export async function waitForNotes(c: any) {
  const p = notesPending.get(c.id);
  if (p) await Promise.race([p, new Promise(r => setTimeout(r, 6000))]);
}

// When a chat ends, keep what matters about you long-term (in the background).
export const reflecting = new Set();
export async function reflectChat(c: any, { quiet = false } = {}) {
  if (!c?.messages?.length || reflecting.has(c.id)) return;
  const s = await getSettings();
  if (!s.memoryAuto) return;
  if ((c.reflectedUpTo || 0) >= c.messages.length) return;
  reflecting.add(c.id);
  try {
    await waitForNotes(c);
    const profile = await getProfile();
    const userName = (profile.preferredName || profile.fullName || "").split(/\s+/)[0] || "the user";
    const r = await reflectOnChat(c, { userName });
    c.reflectedUpTo = c.messages.length;
    await patchStoredChat(c.id, { reflectedUpTo: c.reflectedUpTo, notes: c.notes || [] });
    const n = r ? r.added.length + r.updated.length : 0;
    const sk = r?.skills || [];
    if (!quiet && r && (n || r.aboutChanged || sk.length)) {
      const what = [...r.added, ...r.updated].slice(0, 2).map(t => `“${t}”`).join(", ");
      const skillText = sk.length ? `${sk[0].op === "created" ? "Learned a new skill" : "Improved a skill"}: “${sk[0].name}”${sk.length > 1 ? " and 1 more" : ""}.` : "";
      const memText = n ? `Learned ${n} thing${n > 1 ? "s" : ""} about you: ${what}${n > 2 ? "…" : ""}` : r.aboutChanged ? "Updated how I work with you." : "";
      showToast([memText, skillText].filter(Boolean).join(" "), {
        label: "Review", onClick: () => chrome.tabs.create({ url: chrome.runtime.getURL(`profile.html#${sk.length && !n ? "sec-skills" : "sec-memories"}`) })
      });
    }
  } catch (err: any) {
    console.warn("Couldn't review chat", err);
  } finally {
    reflecting.delete(c.id);
  }
}

// Chats that ended without a review (e.g. Chrome was closed) are reviewed on next start.
export async function reflectStaleChats() {
  const index = (await loadIndex()).slice(0, 5);
  const idle = 30 * 60 * 1000;
  for (const entry of index) {
    if (entry.id === chat.id && Date.now() - entry.updatedAt < idle) continue;
    const data = await chrome.storage.local.get("chat:" + entry.id);
    const c = data["chat:" + entry.id];
    if (c && ((c as any).reflectedUpTo || 0) < (c as any).messages.length) await reflectChat(c, { quiet: true });
  }
}

// ---------- pinned notes UI ----------

export function renderPin() {
  const n = (chat.notes || []).length;
  const btn = $("#pinBtn");
  btn.classList.toggle("hidden", !n);
  btn.querySelector(".pin-count").textContent = n;
  btn.title = `${n} pinned note${n === 1 ? "" : "s"} for this chat`;
  if (!$("#pinPop").classList.contains("hidden")) renderPinList();
}

export function renderPinList() {
  const ul = $("#pinList");
  ul.innerHTML = "";
  for (const [i, note] of (chat.notes || []).entries()) {
    const li = document.createElement("li");
    li.innerHTML = `<span></span><button type="button" class="mini-x" aria-label="Remove note">${ICON.x}</button>`;
    li.firstChild!.textContent = note;
    li.querySelector("button")!.onclick = () => {
      chat.notes!.splice(i, 1);
      saveChat().catch(() => {});
      renderPin();
      renderPinList();
    };
    ul.appendChild(li);
  }
}

export function togglePin(open?: boolean) {
  const pop = $("#pinPop");
  const show = open ?? pop.classList.contains("hidden");
  pop.classList.toggle("hidden", !show);
  if (show) renderPinList();
}

export async function deleteChat(id: any) {
  const index = (await loadIndex()).filter((c: any) => c.id !== id);
  await chrome.storage.local.set({ chatIndex: index });
  await chrome.storage.local.remove("chat:" + id);
  if (chat.id === id) startNewChat();
  renderChatList();
}

// ---------- history drawer ----------

export let drawerOpen = false;

export function setDrawer(open: any) {
  drawerOpen = open;
  $("#drawer").classList.toggle("open", open);
  $("#drawer").setAttribute("aria-hidden", String(!open));
  $("#drawerScrim").classList.toggle("hidden", !open);
  if (open) {
    $("#chatSearch").value = "";
    renderChatList();
    $("#chatSearch").focus();
  }
}

export async function renderChatList() {
  const list = $("#chatList");
  const q = $("#chatSearch").value.trim().toLowerCase();
  const index = (await loadIndex()).filter((c: any) => !q || c.title.toLowerCase().includes(q));
  list.innerHTML = "";
  if (!index.length) {
    list.innerHTML = `<p class="chat-empty">${q ? "No matching chats." : "No saved chats yet."}</p>`;
    return;
  }
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const DAY = 86_400_000;
  const groupOf = (t: any) =>
    t >= startOfToday ? "Today" : t >= startOfToday - DAY ? "Yesterday" : t >= startOfToday - 7 * DAY ? "Previous 7 days" : "Older";
  let lastGroup = "";
  for (const c of index) {
    const g = groupOf(c.updatedAt);
    if (g !== lastGroup) {
      const h = document.createElement("div");
      h.className = "chat-group";
      h.textContent = g;
      list.appendChild(h);
      lastGroup = g;
    }
    const row = document.createElement("div");
    row.className = "chat-row" + (c.id === chat.id ? " current" : "");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "chat-open";
    open.textContent = c.title || "Untitled";
    open.onclick = () => { openChat(c.id); setDrawer(false); };
    const del = document.createElement("button");
    del.type = "button";
    del.className = "chat-del";
    del.title = "Delete chat";
    del.setAttribute("aria-label", "Delete chat");
    del.innerHTML = ICON.trash;
    del.onclick = () => deleteChat(c.id);
    row.append(open, del);
    list.appendChild(row);
  }
}
