// The Memory page (docs/DESIGN.md §5): the fact store and the answer bank, editable. Everything is
// rendered as text; values may have come from forms he filled.
import { $ } from "../shared/dom.js";
import { EXTRA_FACTS, getFacts, setFact } from "../../memory/facts.js";
import { deleteAnswer, editAnswer, getAnswers, type SavedAnswer } from "../../memory/answers.js";

type Child = Node | string | null | undefined | false;
function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}
const day = (t: number) => t ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
const SOURCE: Record<string, string> = { profile: "profile", resume: "resume", chat: "from a chat", application: "from an application", you: "you" };
const say = (t: string) => { $("#saveState").textContent = t; };

export async function renderFacts(): Promise<void> {
  const facts = await getFacts();
  const box = $("#extraFacts");
  box.replaceChildren();
  for (const [key, label] of Object.entries(EXTRA_FACTS)) {
    const f = facts.find(x => x.key === key);
    const input = h("input", { type: "text", "data-key": key, spellcheck: "false" }) as HTMLInputElement;
    input.value = f?.value || "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    input.oninput = () => {
      clearTimeout(timer);
      say("Saving…");
      timer = setTimeout(async () => {
        try { await setFact(key, input.value, "you"); say("Saved"); }
        catch (err: any) { say(err.message); }
      }, 500);
    };
    box.append(h("label", {}, label, input, f ? h("span", { class: "fact-meta" }, `${SOURCE[f.source] || f.source} · ${day(f.updatedAt)}`) : ""));
  }
  const prof = facts.filter(f => f.source === "profile");
  $("#profileFacts").replaceChildren(...prof.flatMap(f => [h("dt", {}, f.label), h("dd", {}, f.value)]));
  if (!prof.length) $("#profileFacts").replaceChildren(h("dd", { class: "muted" }, "Nothing yet: fill in your profile or upload your resume there."));
}

function renderAnswer(a: SavedAnswer): HTMLElement {
  const li = h("li", { "data-id": a.id });
  const text = h("textarea", { "aria-label": "Answer" }) as HTMLTextAreaElement;
  text.value = a.answer;
  text.onchange = async () => { await editAnswer(a.id, text.value); say("Saved"); };
  const del = h("button", { type: "button", class: "ghost small" }, "Delete");
  del.onclick = async () => { await deleteAnswer(a.id); await renderAnswers(); say("Deleted"); };
  li.append(
    h("div", {}, h("div", { class: "q" }, a.question), h("div", { class: "meta" }, [`asked ${a.askedAt.length}×`, a.site, `updated ${day(a.updatedAt)}`, a.options?.length ? `options: ${a.options.slice(0, 6).join(" / ")}` : ""].filter(Boolean).join(" · "))),
    h("div", { class: "acts" }, del),
    text
  );
  return li;
}
export async function renderAnswers(): Promise<void> {
  const q = String($("#answerSearch").value || "").trim().toLowerCase();
  const all = await getAnswers();
  const shown = all.filter(a => !q || `${a.question} ${a.answer}`.toLowerCase().includes(q));
  $("#answerList").replaceChildren(...shown.map(renderAnswer));
  $("#answerCount").textContent = `${all.length} saved`;
  $("#answerEmpty").hidden = all.length > 0;
}

if ($("#memoryApp")) {
  $("#answerSearch").oninput = () => renderAnswers();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.answers) renderAnswers();
    if (changes.facts || changes.profile) { if (!document.activeElement?.closest("#extraFacts")) renderFacts(); }
  });
  renderFacts();
  renderAnswers();
}
