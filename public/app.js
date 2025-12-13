// ---------- State ----------
const state = {
  apiKey: "",
  userFirst: "",
  userLast: "",
  messages: [] // {id, role, who, text, image?, ts}
};

// ---------- Elements ----------
const elApiKey = document.getElementById("apiKey");
const elFirst = document.getElementById("firstName");
const elLast = document.getElementById("lastName");
const elInput = document.getElementById("teacherInput");
const elSend = document.getElementById("sendBtn");
const elSave = document.getElementById("saveBtn");
const elChat = document.getElementById("chat");

// ---------- Helpers ----------
function safeNamePart(s) {
  return (s || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "");
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildTranscriptFull() {
  // "Taylor: ..." + "Firstname Lastname: ..."
  const userLabel = `${state.userFirst || "User"} ${state.userLast || ""}`.trim();
  return state.messages
    .filter(m => m.role === "user" || (m.role === "assistant" && m.who === "taylor"))
    .map(m => {
      const prefix = (m.role === "assistant") ? "Taylor" : userLabel;
      return `${prefix}: ${m.text}`;
    })
    .join("\n");
}

function buildTranscriptUserOnly() {
  // only user's messages, compact transcript
  return state.messages
    .filter(m => m.role === "user")
    .map(m => m.text)
    .join("\n");
}

function filenameFor(kind) {
  const first = safeNamePart(state.userFirst) || "First";
  const last = safeNamePart(state.userLast) || "Last";
  if (kind === "chat") return `${last}_${first}_chat.txt`;
  return `${last}_${first}_all.txt`;
}

// ---------- API ----------
async function fetchTaylorReply() {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: state.apiKey,
      // Only send role/content to backend
      messages: state.messages.map(m => ({ role: m.role, content: m.text }))
    })
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new Error("Bad server response");
  }

  // server returns 200 even on rate-limit so UI won't crash
  const reply = (data?.reply || "").toString().trim();
  const image = data?.image || null;

  if (!reply) throw new Error("Empty reply");
  return { reply, image };
}

// ---------- Render ----------
function renderChat() {
  elChat.innerHTML = "";

  for (const m of state.messages) {
    const row = document.createElement("div");
    row.className = `msg-row ${m.role === "user" ? "user" : "assistant"}`;

    const bubble = document.createElement("div");
    bubble.className = `bubble ${m.role === "user" ? "bubble-user" : "bubble-assistant"}`;

    bubble.textContent = m.text;

    // Optional image (only when user explicitly asked)
    if (m.image) {
      const img = document.createElement("img");
      img.src = m.image;
      img.alt = "fraction diagram";
      img.className = "chat-image";
      bubble.appendChild(img);
    }

    row.appendChild(bubble);
    elChat.appendChild(row);
  }

  elChat.scrollTop = elChat.scrollHeight;
}

// ---------- Actions ----------
async function sendTeacherMessage() {
  const text = (elInput.value || "").trim();
  if (!text) return;

  // Update user fields
  state.apiKey = (elApiKey.value || "").trim();
  state.userFirst = (elFirst.value || "").trim();
  state.userLast = (elLast.value || "").trim();

  if (!state.apiKey) {
    alert("Please enter your OpenAI API key.");
    return;
  }

  // Push teacher message
  state.messages.push({
    id: crypto.randomUUID(),
    role: "user",
    who: "teacher",
    text,
    image: null,
    ts: new Date().toISOString()
  });

  elInput.value = "";
  renderChat();

  // Fetch Taylor
  try {
    const taylor = await fetchTaylorReply();
    state.messages.push({
      id: crypto.randomUUID(),
      role: "assistant",
      who: "taylor",
      text: taylor.reply,
      image: taylor.image || null,
      ts: new Date().toISOString()
    });
    renderChat();
  } catch (e) {
    // Show error as assistant bubble
    state.messages.push({
      id: crypto.randomUUID(),
      role: "assistant",
      who: "taylor",
      text: "Connection error. Please try again.",
      image: null,
      ts: new Date().toISOString()
    });
    renderChat();
    console.error(e);
  }
}

function saveTranscripts() {
  // Update names from inputs (so file name matches latest)
  state.userFirst = (elFirst.value || "").trim();
  state.userLast = (elLast.value || "").trim();

  const full = buildTranscriptFull();
  const userOnly = buildTranscriptUserOnly();

  downloadText(filenameFor("chat"), full);
  downloadText(filenameFor("all"), userOnly);
}

// ---------- Events ----------
elSend.addEventListener("click", () => sendTeacherMessage());
elInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendTeacherMessage();
  }
});
elSave.addEventListener("click", () => saveTranscripts());

// Initial render
renderChat();
