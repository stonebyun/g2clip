
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


// 마지막 sync에서 확인한 Supabase 원본 메타데이터
// 디버깅/고급 정보 UI용이며 Supabase에 저장하지 않음
const remoteClipMetaMap = new Map();


function updateRemoteClipMeta(remoteClip) {
    if (!remoteClip?.id) return;

    remoteClipMetaMap.set(remoteClip.id, {
        revision: Number(remoteClip.revision ?? 0),

        created_at: remoteClip.created_at ?? null,
        updated_at: remoteClip.updated_at ?? null,

        client_created_at: remoteClip.client_created_at ?? null,
        client_updated_at: remoteClip.client_updated_at ?? null,

        server_created_at: remoteClip.server_created_at ?? null,
        server_updated_at: remoteClip.server_updated_at ?? null
    });
}


let db;

// Utility 함수들 in app.js
function formatAdvancedTime(value) {
    if (!value) {
        return "—";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    const formatted =
        new Intl.DateTimeFormat("ko-KR", {
            timeZone: "Asia/Seoul",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        }).format(date);

    return `${formatted}  (${date.toISOString()})`;
}  //Sample: 2026. 08. 21. 13:56:03  (2026-08-21T04:56:03.000Z)


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

/* An IMPORTANT helper func. for simple expression of 'clips' read or write */
function tx(mode = "readonly") {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function getAllClips() { /* readl all clips from 'clips' */
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

async function deleteClipWithTombstone(id) {
    const {
        data: { user },
        error: userError
    } = await supabaseClient.auth.getUser();

    if (userError) {
        throw userError;
    }

    if (!user) {
        throw new Error("로그인된 사용자가 없습니다.");
    }

    const deletedAt = new Date().toISOString();

    // 1. 서버에 삭제 사실부터 기록
    const { error: tombstoneError } = await supabaseClient
        .from("clip_tombstones")
        .upsert(
            {
                clip_id: id,
                user_id: user.id,
                deleted_at: deletedAt
            },
            {
                onConflict: "clip_id",
                ignoreDuplicates: true
            }
        );

    if (tombstoneError) {
        throw tombstoneError;
    }

    // 2. 서버의 실제 clip 삭제
    const { error: deleteRemoteError } = await supabaseClient
        .from("clips")
        .delete()
        .eq("id", id);

    if (deleteRemoteError) {
        throw deleteRemoteError;
    }

    // 3. 로컬 IndexedDB에서도 실제 삭제
    await deleteClip(id);

    // 4. 화면 갱신
    await refresh();

    console.log("🪦 Clip deleted with tombstone:", id);
}


function normalizeClip(raw) {
  const now = new Date().toISOString();
  return { /* .filter(Boolean)은 빈 태그를 제거하는 역할 */
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

    client_created_at: raw.client_created_at ?? null,
    client_updated_at: raw.client_updated_at ?? null,

    server_created_at: raw.server_created_at ?? null,
    server_updated_at: raw.server_updated_at ?? null,

    device_id: raw.device_id || "local-ipad",
    sync_status: raw.sync_status || "local_only",
    /* Invalidated after introduction of revision & base_revision
       on 09:04, 19Aug2026
    version: Number(raw.version || 1),
    */
    revision: Number(raw.revision ?? raw.version ?? 0),
    base_revision: Number(raw.base_revision ?? raw.revision ?? raw.version ?? 0),
  };
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return tags;
  }

  if (typeof tags === "string") {
    return tags
      .split(",")
      .map(tag => tag.trim())
      .filter(Boolean);
  }

  return [];
}

function isTombstoneConflict(error) {
  return (
    error?.code === "P0001" &&
    error?.message === "G2CLIP_TOMBSTONE_CONFLICT"
  );
}

function clipToRemotePayload(clip) {
  return {
    id: clip.id,
    title: clip.title,
    url: clip.url,
    text: clip.text,
    project: clip.project,
    tags: Array.isArray(clip.tags)
      ? clip.tags.join(",")
      : String(clip.tags || ""),
    memo: clip.memo || "",
    importance: clip.importance,
    favorite: clip.favorite,
    created_at: clip.created_at,
    updated_at: clip.updated_at,
  };
}

async function updateClipWithRevisionCheck(clip, userId) {
  const baseRevision = Number(clip.base_revision ?? clip.revision ?? 0);

  const payload = {
    ...clipToRemotePayload(clip),
    user_id: userId,
  };

  const { data, error } = await supabaseClient
    .from("clips")
    .update(payload)
    .eq("id", clip.id)
    .eq("user_id", userId)
    .eq("revision", baseRevision)
    .select();

  if (error) {
    throw error;
  }

  if (!data || data.length === 0) {
    return {
      ok: false,
      conflict: true,
      clip: null,
    };
  }

  return {
    ok: true,
    conflict: false,
    clip: data[0],
  };
}

async function insertNewClip(clip, userId) {
  const payload = {
    ...clipToRemotePayload(clip),
    user_id: userId,
  };

  const { data, error } = await supabaseClient
    .from("clips")
    .insert(payload)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}


function makeRevisionConflictError(clip) {
  const error = new Error(
    `Revision conflict: clip ${clip.id}, base_revision=${clip.base_revision}`
  );

  error.code = "REVISION_CONFLICT";
  error.clipId = clip.id;

  return error;
}

function isRevisionConflict(error) {
  return error?.code === "REVISION_CONFLICT";
}

async function saveClipToSupabase(clip) {
  /* if (clip.title === "UPLOAD3 FAILURE TEST") {
    throw new Error("TEST: forced clip upload failure"); } */
  const {
    data: { user },
    error: userError
  } = await supabaseClient.auth.getUser();

  if (userError) {
    console.error("Supabase user error:", userError);
    return false;
  }

  if (!user) {
    console.log("Not signed in. Saved locally only.");
    return false;
  }

  const payload = {
    id: clip.id,
    user_id: user.id,
    title: clip.title,
    url: clip.url,
    text: clip.text,
    project: clip.project,

    tags: (clip.tags || []).join(", "),
    /* tags: normalizeTags(clip.tags).join(", "), REDUNDANT */
    
    memo: clip.memo,
    importance: clip.importance,
    favorite: clip.favorite,
    created_at: clip.created_at,
    updated_at: clip.updated_at,

    client_created_at: clip.client_created_at,
    client_updated_at: clip.client_updated_at
  };

  /* Changed on 12:15, 18Aug2026
  const { error } = await supabaseClient
    .from("clips")
    .upsert(payload, { onConflict: "id" });
  */

  const revision = Number(clip.revision ?? 0);
  const baseRevision = Number(
    clip.base_revision ?? clip.revision ?? 0
  );

  try {
    // -----------------------------------------
    // 1. 새 로컬 클립 → INSERT
    // -----------------------------------------
    if (revision === 0) {
      const { data, error } = await supabaseClient
        .from("clips")
        .insert(payload)
        .select()
        .single();

      if (error) {
        if (isTombstoneConflict(error)) {
          console.warn(
            "🪦 Supabase rejected stale clip because tombstone exists:",
            clip.id
          );
          throw error;
        }

        console.error("Supabase clip insert error:", error);
        return false;
      }

      console.log(
        "Supabase Clip inserted:",
        clip.id,
        "revision:",
        data.revision
      );

      return data;
    }

    // -----------------------------------------
    // 2. 기존 클립 → revision 조건부 UPDATE
    // -----------------------------------------
    const { data, error } = await supabaseClient
      .from("clips")
      .update(payload)
      .eq("id", clip.id)
      .eq("user_id", user.id)
      .eq("revision", baseRevision)
      .select()
      .maybeSingle();

    if (error) {
      if (isTombstoneConflict(error)) {
        console.warn(
          "🪦 Supabase rejected stale clip because tombstone exists:",
          clip.id
        );
        throw error;
      }

      console.error("Supabase clip update error:", error);
      return false;
    }

    // UPDATE 조건을 만족하는 행이 없었음
    // 즉 서버 revision이 base_revision과 달라졌거나,
    // 서버 row가 삭제된 상태
    if (!data) {
      console.warn(
        "⚠️ Revision conflict:",
        clip.id,
        "base_revision:",
        baseRevision
      );

      throw makeRevisionConflictError(clip);
    }

    console.log(
      "Supabase Clip updated:",
      clip.id,
      "revision:",
      data.revision
    );

    return data;

  } catch (error) {
    if (
      isTombstoneConflict(error) ||
      isRevisionConflict(error)
    ) {
      throw error;
    }

    console.error("Supabase clip save error:", error);
    return false;
  }
} /* END of async function saveClipToSupabase(clip)  */



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

    const tagList = Array.isArray(clip.tags)
      ? clip.tags
      : typeof clip.tags === "string"
        ? clip.tags.split(",").map(tag => tag.trim()).filter(Boolean)
        : [];

    tagList.forEach((tag) => {
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

      clip.sync_status = "local_only"; /* 왜냐하면 별표를 바꾸는 순간: IndexedDB ≠ Supabase */

      await putClip(clip);
      await refresh();
    });

    const link = node.querySelector(".open-link");
    if (clip.url) {
      link.href = clip.url;
      link.hidden = false;
    } else {
      link.hidden = true;
    }

    node.querySelector(".edit-button").addEventListener("click", () => openDialog(clip));
    list.appendChild(node);
  });

  $("clipCount").textContent = `${clips.length}개 클립`;

  $("emptyState").hidden = clips.length > 0;
  list.hidden = clips.length === 0;
  /* OLD Error: state.clips --> clips
     전체 0개 → "첫 클립을 저장해 보세요"
     필터 결과 0개 → "조건에 맞는 클립이 없습니다"
  */

  updateProjectControls(); /* 현재 state의 clip 목록을 바탕으로 프로젝트 선택 목록 등을 다시 재구성? */
}  /* End of function render() */


function renderAdvancedClipInfo(rootElement, clip) {
    if (!rootElement || !clip) {
        return;
    }

    const remote = remoteClipMetaMap.get(clip.id);

    // 기존 패널이 있으면 제거 후 다시 생성
    const oldPanel =
        rootElement.querySelector("[data-clip-advanced-info]");

    if (oldPanel) {
        oldPanel.remove();
    }

    const details = document.createElement("details");
    details.className = "clip-advanced-info";
    details.dataset.clipAdvancedInfo = "true";

    const summary = document.createElement("summary");
    summary.textContent = "고급 정보";
    details.appendChild(summary);

    const grid = document.createElement("div");
    grid.className = "clip-advanced-info-grid";

    function addRow(label, value, className = "") {
        const labelElement = document.createElement("div");
        labelElement.className = "clip-advanced-label";
        labelElement.textContent = label;

        const valueElement = document.createElement("div");
        valueElement.className =
            `clip-advanced-value ${className}`.trim();

        valueElement.textContent =
            value === null ||
            value === undefined ||
            value === ""
                ? "—"
                : String(value);

        grid.appendChild(labelElement);
        grid.appendChild(valueElement);
    }

    /*
     * 앞으로 사용할 명시적 client timestamp.
     * 아직 migration 전이면 — 로 보이는 것이 정상.
     */
    addRow(
        "Client created_at",
        formatAdvancedTime(clip.client_created_at)
    );

    addRow(
        "Client updated_at",
        formatAdvancedTime(clip.client_updated_at)
    );

    /*
     * 앞으로 사용할 명시적 server timestamp.
     */
    addRow(
        "Server created_at",
        formatAdvancedTime(
            remote?.server_created_at ??
            clip.server_created_at
        )
    );

    addRow(
        "Server updated_at",
        formatAdvancedTime(
            remote?.server_updated_at ??
            clip.server_updated_at
        )
    );

    /*
     * 현재 legacy timestamp.
     * timestamp migration이 끝날 때까지 비교용으로 유지.
     */
    addRow(
        "Local legacy created_at",
        formatAdvancedTime(clip.created_at)
    );

    addRow(
        "Local legacy updated_at",
        formatAdvancedTime(clip.updated_at)
    );

    addRow(
        "Server legacy created_at",
        formatAdvancedTime(remote?.created_at)
    );

    addRow(
        "Server legacy updated_at",
        formatAdvancedTime(remote?.updated_at)
    );

    /*
     * Revision
     */
    addRow(
        "Local revision",
        clip.revision ?? "—"
    );

    addRow(
        "Base revision",
        clip.base_revision ?? "—"
    );

    addRow(
        "Server revision",
        remote?.revision ?? "—"
    );

    addRow(
        "Sync status",
        clip.sync_status ?? "—",
        `sync-${clip.sync_status ?? "unknown"}`
    );

    addRow(
        "Clip ID",
        clip.id ?? "—"
    );

    details.appendChild(grid);
    rootElement.appendChild(details);
} /* END of function renderAdvancedClipInfo(rootElement, clip)  */

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

  const submodal = $("clipForm");
  renderAdvancedClipInfo(submodal, clip);

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
    
    client_created_at:
        existing?.client_created_at ??
        existing?.created_at ??
        now,

    client_updated_at: existing ? now : null,

    sync_status: "local_only",
    revision: existing?.revision ?? 0,
    base_revision:
      existing?.base_revision ?? existing?.revision ?? 0,
    //version: (existing?.version || 0) + 1,
  });

  if (!clip.title || !clip.text) {
    alert("제목과 클립 내용은 필수입니다.");
    return;
  }

  
  /* 서버 저장보다 로컬 저장 IndexedDB 저장을 먼저한다 */

  /* Modified on 11:42, 12Aug2026 */
  // 1. 로컬에 먼저 저장
  await putClip(clip);

  // 2. Supabase 저장 시도

  // 3. 서버 저장까지 성공했으면
  // 서버가 반환한 revision까지 로컬에 반영
  // + 로컬 상태도 synced로 변경
  try {

    /* -----------------debugBegin-----------------------------
    console.log(
        "DEBUG before Supabase save:",
        "client_updated_at:",
        clip.client_updated_at,
        clip
    );
     -----------------debugEnd-------------------------------*/

    const savedRemoteClip = await saveClipToSupabase(clip);

    if (savedRemoteClip) {
    /* -----------------debugBegin----------------------------
      console.log(
          "DEBUG after Supabase save:",
          "client_updated_at:",
          savedRemoteClip?.client_updated_at,
          savedRemoteClip
      );
       -----------------debugEnd-------------------------------*/

      const syncedClip = normalizeClip({
        ...savedRemoteClip,

        /* Add #003 on 22Aug2026 */
        sync_status: "synced",
        base_revision: Number(savedRemoteClip.revision ?? 0) 
      });

      //remoteClipMetaMap.set(syncedClip.id, syncedClip);

      // 방금 서버가 반환한 최신 revision / server timestamp를
      // 고급 정보 UI용 Map에도 즉시 반영
      /* >>2<< Supabase에 save 성공 */
      updateRemoteClipMeta(savedRemoteClip);
      /* ----------------------------------- */

      await putClip(syncedClip);
    } else {
      console.log(
        "Supabase 저장 실패. 로컬에는 저장되었습니다."
      );
    }

  } catch (error) {
    if (isRevisionConflict(error)) {
      clip.sync_status = "conflict";
      await putClip(clip);

      console.warn(
        "⚠️ Edit conflict detected in saveForm. Local version preserved:",
        clip.id,
        "base_revision:",
        clip.base_revision
      );
    }
    else if (isTombstoneConflict(error)) {
      await deleteClip(clip.id);

      console.warn(
        "🪦 Delete-wins: stale local edit removed in saveForm:",
        clip.id
      );
    }
      else {
      clip.sync_status = "pending";
      await putClip(clip);

      console.error(
        "❌ Supabase save error. Local version kept pending:",
        clip.id,
        error
      );
    }
  }

  closeDialog();
  await refresh();
} /* END of sync function saveForm() { */

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

    /* Replaced on 12:43, 16Aug2026.
    await deleteClip(id);
    closeDialog();
    await refresh();
    */

    await deleteClipWithTombstone(id);
    closeDialog();

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

async function checkAuthSession() {
  const { data, error } = await supabaseClient.auth.getSession();

  if (error) {
    console.error('Supabase auth session error:', error);
    return;
  }

  console.log('Supabase session:', data.session);
}

checkAuthSession();



const authEmail = document.getElementById("authEmail");
const authPassword = document.getElementById("authPassword");
const signUpBtn = document.getElementById("signUpBtn");
const signInBtn = document.getElementById("signInBtn");
const signOutBtn = document.getElementById("signOutBtn");
const authStatus = document.getElementById("authStatus");

async function updateAuthUI() {
  const {
    data: { session },
    error
  } = await supabaseClient.auth.getSession();

  if (error) {
    console.error("Auth session error:", error);
    authStatus.textContent = "인증 상태 확인 오류";
    return;
  }

  if (session?.user) {
    authStatus.textContent = session.user.email;
    signUpBtn.hidden = true;
    signInBtn.hidden = true;
    signOutBtn.hidden = false;
    authEmail.hidden = true;
    authPassword.hidden = true;
  } else {
    authStatus.textContent = "로그인되지 않음";
    signUpBtn.hidden = false;
    signInBtn.hidden = false;
    signOutBtn.hidden = true;
    authEmail.hidden = false;
    authPassword.hidden = false;
  }
}

signUpBtn.addEventListener("click", async () => {
  const email = authEmail.value.trim();
  const password = authPassword.value;

  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password
  });

  if (error) {
    alert(`회원가입 실패: ${error.message}`);
    return;
  }

  alert("회원가입 요청 완료. 이메일 확인 링크를 확인해 주세요.");
  console.log("Sign-up result:", data);
});

signInBtn.addEventListener("click", async () => {
  const email = authEmail.value.trim();
  const password = authPassword.value;

  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    alert(`로그인 실패: ${error.message}`);
    return;
  }

  console.log("Sign-in result:", data);
  await updateAuthUI();
});

signOutBtn.addEventListener("click", async () => {
  const { error } = await supabaseClient.auth.signOut();

  if (error) {
    alert(`로그아웃 실패: ${error.message}`);
    return;
  }

  await updateAuthUI();
});


/* Add by ChatGPT-kBYUN on 17:40, 12Aug2026 */
async function loadClipsFromSupabase() {
    const {
        data: { user },
        error: userError
    } = await supabaseClient.auth.getUser();

    if (userError) {
        console.error("Supabase user 조회 실패:", userError);
        return [];
    }

    if (!user) {
        console.log("로그인된 사용자가 없습니다.");
        return [];
    }

    const { data, error } = await supabaseClient
        .from("clips")
        .select("*")
        .eq("user_id", user.id);

    if (error) {
        console.error("Supabase clips 조회 실패:", error);
        return [];
    }

    /* console.log("Clips loaded from Supabase:", data); */
    /* return data; */
    /* Above two lines changed to following. */
    /* Changed on 22:14, 12Aug2026. N*/

    /* 2026.08.13.목요일.16:07분.... 달라지는 부분: 맵 함수 속에 normalizeClip() 불러 사용 */
    /*
    const normalizedClips = (data || []).map(clip => ({
      ...clip,
      tags: normalizeTags(clip.tags)
    }));
    console.log("Clips loaded from Supabase:", normalizedClips);
    return normalizedClips;
    */

    const clips = (data || []).map(normalizeClip);
    console.log("Clips loaded and normalized from Supabase:", clips);
    return clips;

} /* End of function loadClipsFromSupabase() */


async function loadTombstonesFromSupabase() {
  /* throw new Error("TEST: tombstone fetch failed"); */

    const {
        data: { user },
        error: userError
    } = await supabaseClient.auth.getUser();

    if (userError) {
        console.error("Supabase user 조회 실패:", userError);
        return [];
    }

    if (!user) {
        console.log("로그인된 사용자가 없습니다.");
        return [];
    }

    const { data, error } = await supabaseClient
        .from("clip_tombstones")
        .select("clip_id, user_id, deleted_at")
        .eq("user_id", user.id);

    if (error) {
        console.error("Supabase tombstone 조회 실패:", error);
        /* 위험!: return []; */
        throw error;
    }

    return data || [];
}


async function syncFromSupabase() {
    const remoteClips = await loadClipsFromSupabase();

    for (const clip of remoteClips) {
      await putClip(clip);
    }

    console.log(
      `${remoteClips.length} clip(s) synced from Supabase to IndexedDB`
    );

     return remoteClips;
}


async function syncToSupabase() {
  const localClips = await getAllClips();
  const remoteClips = await loadClipsFromSupabase();

  const remoteIds = new Set(
    remoteClips.map(clip => clip.id)
  );

  let uploadCount = 0;

  for (const clip of localClips) {
    if (!remoteIds.has(clip.id)) {
      await saveClipToSupabase(clip);
      uploadCount++;
    }
  }

  console.log(
    `${uploadCount} clip(s) synced from IndexedDB to Supabase`
  );

  return uploadCount;
}

/* Add on 22:27, 12Aug2026 */
async function syncClips() {
    try {  

        // 0. tombstone을 먼저 읽어서 로컬 삭제에 적용
        const tombstones = 
            await loadTombstonesFromSupabase();

        const tombstoneIds = new Set(
            tombstones.map(tombstone => tombstone.clip_id)
        );

        let localClips = await getAllClips();


        /* debugger; */
        /* Above: stale clip -- delete-wins PROVED! */
        /* on 09:43, 18Aug2026 */

        for (const localClip of localClips) {
            if (tombstoneIds.has(localClip.id)) {
                await deleteClip(localClip.id);

                console.log(
                    "🪦 Tombstone applied locally:",
                    localClip.id
                );
            }
        }

        // tombstone 적용 후 다시 읽어야 함
        localClips = await getAllClips();

        const remoteClips = await loadClipsFromSupabase();



        const localMap = new Map(
            localClips.map(clip => [clip.id, clip])
        );

        const remoteMap = new Map(
            remoteClips.map(clip => [clip.id, clip])
        );


        remoteClipMetaMap.clear();

        for (const remoteClip of remoteClips) {
          updateRemoteClipMeta(remoteClip); 
        }

      /*  const localClips = await getAllClips(); */
      localClips = await getAllClips(); 

      let uploaded = 0;
      let downloaded = 0;
      let unchanged = 0;
      let failed = 0; 

      // 1. 로컬 기준(IndexedDB의 clip들)으로 검사
      for (const localClip of localClips) {

        // tombstone 대상은 절대 업로드하지 않음
        if (tombstoneIds.has(localClip.id)) {
            console.warn(
                "🪦 Upload blocked by tombstone:",
                localClip.id
            );
            continue;
        }


        // 사용자가 해결하기 전에는 conflict 클립 자동 재업로드 금지
        if (localClip.sync_status === "conflict") {
          console.warn(
            "⚠️ Conflict clip skipped from automatic sync:",
            localClip.id,
            "base_revision:",
            localClip.base_revision
          );

          continue;
        }


        const remoteClip = remoteMap.get(localClip.id);

        // Supabase에 없음 → 업로드
        if (!remoteClip) {
            try {
                  const savedRemoteClip = await saveClipToSupabase(localClip);

                  if (savedRemoteClip) {
                    const syncedClip = normalizeClip({
                      ...savedRemoteClip,
                      /* Add #003 on 22Aug2026 */
                      sync_status: "synced",
                      base_revision: Number(savedRemoteClip.revision ?? 0) 
                    });

                    /* Added #002 on 22Aug2026 by kByun */
                    /* >> */
                    updateRemoteClipMeta(savedRemoteClip);
                    /* ---------------------------------- */

                    await putClip(syncedClip);
                    uploaded++;
                  } else {
                      localClip.sync_status = "pending";
                      await putClip(localClip);
                      failed++;

                      console.warn(
                          "⚠️ Clip upload failed, kept pending:",
                          localClip.id
                      );
                  }
            } catch (error) {
                if (isTombstoneConflict(error)) {
                  await deleteClip(localClip.id);

                  console.warn(
                    "🪦 Delete-wins: stale local clip removed after tombstone conflict:",
                    localClip.id
                  );
              
                  continue;
                }

                if (isRevisionConflict(error)) {
                  localClip.sync_status = "conflict";
                  await putClip(localClip);

                  failed++;

                  console.warn(
                    "⚠️ Edit conflict detected. Local version preserved:",
                    localClip.id,
                    "base_revision:",
                    localClip.base_revision
                  );

                  continue;
                }

                localClip.sync_status = "pending";
                await putClip(localClip);
                failed++;

                console.error(
                  "❌ Clip upload error, kept pending:",
                  localClip.id,
                  error
                );
            }

            continue;
        }
      
        
        // 기존 synced 클립의 revision 메타데이터 migration
        if (
          localClip.sync_status === "synced" &&
          (
            localClip.revision == null ||
            localClip.base_revision == null
          ) &&
          remoteClip?.revision != null
        ) {
          localClip.revision = Number(remoteClip.revision);
          localClip.base_revision = Number(remoteClip.revision);

          await putClip(localClip);

          console.log(
            "🔄 Legacy clip revision migrated:",
            localClip.id,
            "revision:",
            localClip.revision
          );
        }


        
        
        // 로컬에 아직 서버로 반영되지 않은 수정이 있으면
        // updated_at보다 revision/base_revision을 먼저 검사한다.
        const hasUnsyncedLocalEdit =
            localClip.sync_status === "pending" ||
            localClip.sync_status === "local_only" ||
            localClip.sync_status === "failed";

        if (hasUnsyncedLocalEdit) {
            const localBaseRevision = Number(localClip.base_revision ?? 0);

            const remoteRevision = Number(remoteClip.revision ?? 0);

            // 내가 수정하기 시작한 이후 서버 revision이 이미 전진함
            if (localBaseRevision !== remoteRevision) {
                localClip.sync_status = "conflict";
                await putClip(localClip);
                failed++;

                console.warn(
                    "⚠️ Edit conflict detected before timestamp merge. Local version preserved:",
                    localClip.id,
                    "base_revision:",
                    localBaseRevision,
                    "remote_revision:",
                    remoteRevision
                );
        
                continue;
            }

            // 서버가 아직 내가 수정하기 시작한 revision 그대로라면
            // timestamp와 관계없이 로컬 수정본 업로드를 시도한다.
            try {
                const savedRemoteClip =
                    await saveClipToSupabase(localClip);

                if (savedRemoteClip) {
                    const syncedClip = normalizeClip({
                        ...savedRemoteClip,
                        sync_status: "synced",
                        /* Add #006 on 22Aug2026 */
                        base_revision: Number(savedRemoteClip.revision ?? 0)
                    });

                    /* Add #007 on 22Aug2026 */
                    updateRemoteClipMeta(savedRemoteClip);

                    await putClip(syncedClip);
                    uploaded++;
                } else {
                    localClip.sync_status = "pending";
                    await putClip(localClip);
                    failed++;
                }
            } catch (error) {
                if (isTombstoneConflict(error)) {
                    await deleteClip(localClip.id);

                    console.warn(
                        "🪦 Delete-wins: stale local edit removed after tombstone conflict:",
                        localClip.id
                    );

                    continue;
                }

                if (isRevisionConflict(error)) {
                    localClip.sync_status = "conflict";
                    await putClip(localClip);
                    failed++;

                    console.warn(
                        "⚠️ Edit conflict detected. Local version preserved:",
                        localClip.id,
                        "base_revision:",
                        localClip.base_revision
                    );

                    continue;
                }

                localClip.sync_status = "pending";
                await putClip(localClip);
                failed++;

                console.error(
                    "❌ Clip update error, kept pending:",
                    localClip.id,
                    error
                );
            }
        
            continue;
        }


        // 양쪽 모두 존재하고, 미동기화 로컬 수정도 없는 상태.
        // 이제 client/server timestamp가 아니라 revision만으로 판단한다.
        const localBaseRevision =
            Number(localClip.base_revision ?? localClip.revision ?? 0);

        const remoteRevision =
            Number(remoteClip.revision ?? 0);

        if (remoteRevision > localBaseRevision) {
            // 다른 기기 등에서 서버 revision이 전진함 → 서버본 다운로드
            const downloadedClip = normalizeClip({
                ...remoteClip,
                sync_status: "synced",
                base_revision: remoteRevision
            });

            await putClip(downloadedClip);
            downloaded++;
        
        } else if (remoteRevision === localBaseRevision) {
            // 내가 알고 있는 서버 revision과 실제 서버 revision이 동일
            // → 변경 없음
            if (
                localClip.sync_status !== "synced" ||
                Number(localClip.revision ?? 0) !== remoteRevision ||
                Number(localClip.base_revision ?? 0) !== remoteRevision
            ) {
                const syncedClip = normalizeClip({
                    ...localClip,
                    revision: remoteRevision,
                    base_revision: remoteRevision,
                    sync_status: "synced"
                });

                await putClip(syncedClip);
            }

            unchanged++;

        } else {
            // 서버 revision이 로컬이 마지막으로 확인한 revision보다 작음.
            // 정상적인 monotonic revision 모델에서는 발생하면 안 되는 상태.
            // 자동 업로드/덮어쓰기는 하지 않고 보존한다.
            localClip.sync_status = "conflict";
            await putClip(localClip);

            failed++;

            console.warn(
                "⚠️ Unexpected revision rollback detected. Local version preserved:",
                localClip.id,
                "base_revision:",
                localBaseRevision,
                "remote_revision:",
                remoteRevision
            );
        }

      }

      // 2. Supabase에만 존재하는 clip 검사 + 삭제한 clip을 같은 sync 안에서 다시 살림 없게!
      for (const remoteClip of remoteClips) {
        if (!localMap.has(remoteClip.id) &&
            !tombstoneIds.has(remoteClip.id)
        ) {
          /* Addo #005 on 22Aug2026 */
          remoteClip.sync_status = "synced"; 
          remoteClip.base_revision = Number(remoteClip.revision ?? 0);
          /* ------------------------------------ */

            await putClip(remoteClip);
            downloaded++;
          }
      }

      // 3. merge 후 tombstone을 마지막으로 다시 적용
      const finalLocalClips = await getAllClips();

      for (const localClip of finalLocalClips) {
          if (tombstoneIds.has(localClip.id)) {
              await deleteClip(localClip.id);

              console.warn(
                  "🪦 Tombstone re-applied after merge:",
                  localClip.id
              );
          }
      }

      /* add following 3 lines on 16:49 on 13Aug2026 */
      await refresh(); 

      console.log(
        `Sync complete: ` +
        `${uploaded} uploaded, ` +
        `${downloaded} downloaded, ` +
        `${unchanged} unchanged, ` + 
        `${failed} failed`
      );

      return {
        uploaded,
        downloaded,
        unchanged,
        failed
      };

    } catch (error) {

        console.error(
            "❌ Sync aborted safely:",
            error
        );
    }

} /* END of async function syncClips() */



function requestSync(reason) {
    console.log(`🔄 Sync requested: ${reason}`);
    syncClips();
}

window.syncClips = syncClips; /* 디버깅용 잠깐 노출 */


window.addEventListener("online", () => {
    requestSync("network-restored");
});

supabaseClient.auth.onAuthStateChange((event, session) => {
    console.log("🔐 Auth state changed:", event);

    if (event === "SIGNED_IN") {
        setTimeout(() => {
            requestSync("signed-in");
        }, 0);
    }
});



async function initializeApp() {
    const {
        data: { session },
        error
    } = await supabaseClient.auth.getSession();

    if (error) {
        console.error("❌ Session check failed:", error);
        return;
    }

    if (session) {
        console.log("🔐 Existing session found");
        requestSync("app-start"); /* syncClips() is called. */
    } else {
        console.log("🔓 No active session");
    }
}




supabaseClient.auth.onAuthStateChange(() => {
  updateAuthUI();
});

updateAuthUI();




/* Race condition occured! */
/*
init();
initializeApp();
*/
async function startApp() {
    await init();
    await initializeApp();
}

startApp();