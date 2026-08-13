
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


async function saveClipToSupabase(clip) {
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
    updated_at: clip.updated_at
  };

  const { error } = await supabaseClient
    .from("clips")
    .upsert(payload, { onConflict: "id" });

  if (error) {
    console.error("Supabase clip save error:", error);
    return false;
  }

  /* console.log("Clip saved to Supabase:", clip.id); */
  console.log("Supabase Clip saved...!:", clip.id);
  return true;
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
    /* sync_status: existing?.sync_status || "local_only", */
    sync_status: "local_only",
    version: (existing?.version || 0) + 1,
  });

  if (!clip.title || !clip.text) {
    alert("제목과 클립 내용은 필수입니다.");
    return;
  }

  
  /* 서버 저장보다 로컬 저장 IndexedDB 저장을 먼저한다 */

  /*
  try {
    await saveClipToSupabase(clip);
  }   
  catch (error) {
    console.error(
      "Supabase 저장 실패. 로컬에는 저장되었습니다.",
      error
    );
  }
  */

  /* Modified on 11:42, 12Aug2026 */
  // 1. 로컬에 먼저 저장
  await putClip(clip);

  // 2. Supabase 저장 시도
  const synced = await saveClipToSupabase(clip);

  // 3. 서버 저장까지 성공했으면 로컬 상태도 synced로 변경
  if (synced) {
    clip.sync_status = "synced";
    await putClip(clip);
  }
  else
    console.log("Supabase 저장 실패. 로컬에는 저장되었습니다.");




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
  const localClips = await getAllClips();
  const remoteClips = await loadClipsFromSupabase();

  const localMap = new Map(
    localClips.map(clip => [clip.id, clip])
  );

  const remoteMap = new Map(
    remoteClips.map(clip => [clip.id, clip])
  );

  let uploaded = 0;
  let downloaded = 0;
  let unchanged = 0;

  // 1. 로컬 기준(IndexedDB의 clip들)으로 검사
  for (const localClip of localClips) {
    const remoteClip = remoteMap.get(localClip.id);

    // Supabase에 없음 → 업로드
    if (!remoteClip) {
      const synced =
        await saveClipToSupabase(localClip);

      if (synced) {
        localClip.sync_status = "synced"; /* Add on 16:31, 13Aug2026 */
        await putClip(localClip); /* Add on 16:31, 13Aug2026 */
        uploaded++;
      }

      continue;
    }

    // 양쪽 모두 있음 → updated_at 비교
    const localTime =
      new Date(localClip.updated_at).getTime();

    const remoteTime =
      new Date(remoteClip.updated_at).getTime();

    if (localTime > remoteTime) {
      // 로컬이 최신
      const synced = /* success -> synced */
        await saveClipToSupabase(localClip);

      if (synced) {
        localClip.sync_status = "synced"; /* Add on 16:38, 13Aug2026 */
        await putClip(localClip); /* Add on 16:38, 13Aug2026 */
        uploaded++;
      }

    } else if (remoteTime > localTime) {
      // 서버DB Supabase가 최신
      remoteClip.sync_status = "synced"; /* Add on 16:42, 13Aug2026 */
      await putClip(remoteClip);
      downloaded++;

    } else {
      // 동일
      /* add following 3 lines on 16:45 on 13Aug2026..양쪽 수정시각이 동일 */
      if (localClip.sync_status !== "synced") {
        localClip.sync_status = "synced";
        await putClip(localClip);
      }

      unchanged++;
    }
  }

  // 2. Supabase에만 존재하는 clip 검사
  for (const remoteClip of remoteClips) {
    if (!localMap.has(remoteClip.id)) {
      await putClip(remoteClip);
      downloaded++;
    }
  }

  /* add following 3 lines on 16:49 on 13Aug2026 */
  await refresh(); 

  console.log(
    `Sync complete: ` +
    `${uploaded} uploaded, ` +
    `${downloaded} downloaded, ` +
    `${unchanged} unchanged`
  );

  return {
    uploaded,
    downloaded,
    unchanged
  };
}



function requestSync(reason) {
    console.log(`🔄 Sync requested: ${reason}`);
    syncClips();
}

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
        requestSync("app-start");
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