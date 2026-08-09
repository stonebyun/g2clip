
const DB_NAME = "g2clip-db";
const DB_VERSION = 1;
const STORE_NAME = "clips";

const DEFAULT_PROJECTS = [
  "KangPCM", "G2Layer", "KangSafeCover", "KangSwitch",
  "특허·지식재산", "투자·사업", "논문·기술", "법률"
];

const $ = (id) => document.getElementById(id);

const state = {
  clips: [],
  search: "",
  project: "",
  favoriteOnly: false,
};

let db;

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() :
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("updated_at", "updated_at");
        store.createIndex("project", "project");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(mode = "readonly") {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function getAllClips() {
  return new Promise((resolve, reject) => {
    const request = tx().getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function putClip(clip) {
  return new Promise((resolve, reject) => {
    const request = tx("readwrite").put(clip);
    request.onsuccess = () => resolve(clip);
    request.onerror = () => reject(request.error);
  });
}

function deleteClip(id) {
  return new Promise((resolve, reject) => {
    const request = tx("readwrite").delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function normalizeClip(raw) {
  const now = new Date().toISOString();
  return {
    id: raw.id || uuid(),
    user_id: raw.user_id || null,
    title: String(raw.title || "").trim(),
    url: String(raw.url || "").trim(),
    text: String(raw.text || "").trim(),
    project: String(raw.project || "").trim(),
    tags: Array.isArray(raw.tags)
      ? raw.tags.map(v => String(v).trim()).filter(Boolean)
      : String(raw.tags || "").split(",").map(v => v.trim()).filter(Boolean),
    memo: String(raw.memo || "").trim(),
    importance: Math.min(5, Math.max(1, Number(raw.importance || 3))),
    favorite: Boolean(raw.favorite),
    created_at: raw.created_at || now,
    updated_at: raw.updated_at || now,
    device_id: raw.device_id || "local-ipad",
    sync_status: raw.sync_status || "local_only",
    version: Number(raw.version || 1),
  };
}

async function refresh() {
  state.clips = (await getAllClips()).sort((a, b) =>
    new Date(b.updated_at) - new Date(a.updated_at)
  );
  render();
}

function filteredClips() {
  const q = state.search.trim().toLowerCase();

  return state.clips.filter((clip) => {
    const haystack = [
      clip.title, clip.url, clip.text, clip.project,
      clip.memo, ...(clip.tags || [])
    ].join(" ").toLowerCase();

    return (!q || haystack.includes(q))
      && (!state.project || clip.project === state.project)
      && (!state.favoriteOnly || clip.favorite);
  });
}

function render() {
  const clips = filteredClips();
  const list = $("clipList");
  list.innerHTML = "";

  clips.forEach((clip) => {
    const node = $("clipCardTemplate").content.cloneNode(true);
    node.querySelector(".clip-title").textContent = clip.title || "제목 없음";

    const date = new Date(clip.updated_at).toLocaleString("ko-KR", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit"
    });

    node.querySelector(".clip-meta").textContent =
      `${clip.project || "미분류"} · 중요도 ${"★".repeat(clip.importance)}${"☆".repeat(5 - clip.importance)} · ${date}`;

    node.querySelector(".clip-text").textContent = clip.text;
    const memo = node.querySelector(".clip-memo");
    memo.textContent = clip.memo;
    memo.hidden = !clip.memo;

    const tags = node.querySelector(".tags");
    (clip.tags || []).forEach((tag) => {
      const span = document.createElement("span");
      span.className = "tag";
      span.textContent = `#${tag}`;
      tags.appendChild(span);
    });

    const favoriteButton = node.querySelector(".favorite-button");
    favoriteButton.textContent = clip.favorite ? "★" : "☆";
    favoriteButton.classList.toggle("active", clip.favorite);
    favoriteButton.addEventListener("click", async () => {
      clip.favorite = !clip.favorite;
      clip.updated_at = new Date().toISOString();
      clip.version = (clip.version || 1) + 1;
      await putClip(clip);
      await refresh();
    });

    const link = node.querySelector(".open-link");
    if (clip.url) {
      link.href = clip.url;
    } else {
      link.hidden = true;
    }

    node.querySelector(".edit-button").addEventListener("click", () => openDialog(clip));
    list.appendChild(node);
  });

  $("clipCount").textContent = `${clips.length}개 클립`;
  $("emptyState").hidden = state.clips.length > 0;
  list.hidden = state.clips.length === 0;

  updateProjectControls();
}

function updateProjectControls() {
  const projects = [...new Set([
    ...DEFAULT_PROJECTS,
    ...state.clips.map(c => c.project).filter(Boolean)
  ])].sort((a, b) => a.localeCompare(b, "ko"));

  const filter = $("projectFilter");
  const current = filter.value;
  filter.innerHTML = '<option value="">모든 프로젝트</option>';
  projects.forEach(project => {
    const option = document.createElement("option");
    option.value = project;
    option.textContent = project;
    filter.appendChild(option);
  });
  filter.value = current;

  const dataList = $("projectOptions");
  dataList.innerHTML = "";
  projects.forEach(project => {
    const option = document.createElement("option");
    option.value = project;
    dataList.appendChild(option);
  });
}

function openDialog(clip = null) {
  $("clipForm").reset();
  $("clipId").value = clip?.id || "";
  $("dialogTitle").textContent = clip ? "클립 수정" : "새 클립";
  $("deleteBtn").classList.toggle("hidden", !clip);

  if (clip) {
    $("titleInput").value = clip.title;
    $("urlInput").value = clip.url;
    $("textInput").value = clip.text;
    $("projectInput").value = clip.project;
    $("importanceInput").value = String(clip.importance);
    $("tagsInput").value = (clip.tags || []).join(", ");
    $("memoInput").value = clip.memo;
    $("favoriteInput").checked = clip.favorite;
  } else {
    $("importanceInput").value = "3";
  }

  $("clipDialog").showModal();
  setTimeout(() => $("titleInput").focus(), 50);
}

function closeDialog() {
  $("clipDialog").close();
}

async function saveForm() {
  const existing = state.clips.find(c => c.id === $("clipId").value);
  const now = new Date().toISOString();

  const clip = normalizeClip({
    ...existing,
    id: existing?.id || uuid(),
    title: $("titleInput").value,
    url: $("urlInput").value,
    text: $("textInput").value,
    project: $("projectInput").value,
    importance: $("importanceInput").value,
    tags: $("tagsInput").value,
    memo: $("memoInput").value,
    favorite: $("favoriteInput").checked,
    created_at: existing?.created_at || now,
    updated_at: now,
    sync_status: existing?.sync_status || "local_only",
    version: (existing?.version || 0) + 1,
  });

  if (!clip.title || !clip.text) {
    alert("제목과 클립 내용은 필수입니다.");
    return;
  }

  await putClip(clip);
  closeDialog();
  await refresh();
}

async function exportJson() {
  const payload = {
    app: "G2Clip",
    schema_version: 1,
    exported_at: new Date().toISOString(),
    clips: state.clips,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `g2clip-backup-${new Date().toISOString().slice(0,10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    const clips = Array.isArray(data) ? data : data.clips;
    if (!Array.isArray(clips)) throw new Error("클립 배열을 찾을 수 없습니다.");

    for (const item of clips) {
      const clip = normalizeClip(item);
      if (!clip.title || !clip.text) continue;
      await putClip(clip);
    }

    await refresh();
    alert(`${clips.length}개 항목을 불러왔습니다.`);
  } catch (error) {
    console.error(error);
    alert("JSON 파일을 읽지 못했습니다.");
  }
}

function bindEvents() {
  $("newClipBtn").addEventListener("click", () => openDialog());
  $("emptyNewBtn").addEventListener("click", () => openDialog());
  $("closeDialogBtn").addEventListener("click", closeDialog);
  $("cancelBtn").addEventListener("click", closeDialog);

  $("clipForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveForm();
  });

  $("deleteBtn").addEventListener("click", async () => {
    const id = $("clipId").value;
    if (!id || !confirm("이 클립을 삭제할까요?")) return;
    await deleteClip(id);
    closeDialog();
    await refresh();
  });

  $("searchInput").addEventListener("input", (event) => {
    state.search = event.target.value;
    render();
  });

  $("projectFilter").addEventListener("change", (event) => {
    state.project = event.target.value;
    render();
  });

  $("favoriteFilter").addEventListener("change", (event) => {
    state.favoriteOnly = event.target.value === "favorite";
    render();
  });

  $("exportBtn").addEventListener("click", exportJson);
  $("importInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file) await importJson(file);
    event.target.value = "";
  });
}

async function init() {
  try {
    db = await openDatabase();
    bindEvents();
    await refresh();

    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("./sw.js").catch(console.warn);
    }
  } catch (error) {
    console.error(error);
    alert("브라우저 저장소를 열 수 없습니다. 일반 Safari 창에서 다시 시도하세요.");
  }
}

init();
