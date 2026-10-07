/* Application portal: answer player, transcript sync, and PostHog tracking.
   A company page provides <script type="application/json" id="portal-config"> and the markup ids used below. */
(function () {
  const $ = id => document.getElementById(id);
  const config = JSON.parse($("portal-config").textContent);
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Videos live on external storage; local previews read the edit folder instead.
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  const mediaBase = local ? (config.localMediaBase || "/videos/edits/") : (config.mediaBase || "");
  const mediaUrl = p => !p ? null : /^(https?:)?\/\//.test(p) || p.startsWith("/") ? p : mediaBase + p;
  const label = i => Q[i].kind === "extra" ? Q[i].label : `Q${Q.slice(0, i + 1).filter(q => q.kind !== "extra").length}`;

  /* ── Owner mode: visit with ?me=1 once so your own views aren't tracked (?me=0 to undo) ── */
  const params = new URLSearchParams(location.search);
  try {
    if (params.get("me") === "1") localStorage.setItem("portal_owner", "1");
    if (params.get("me") === "0") localStorage.removeItem("portal_owner");
  } catch (e) {}
  let owner = false;
  try { owner = localStorage.getItem("portal_owner") === "1"; } catch (e) {}
  const ph = () => (!owner && window.posthog && typeof window.posthog.capture === "function") ? window.posthog : null;
  if (owner && window.posthog) window.posthog.opt_out_capturing();

  /* ── Session state, sent as one summary event when the visitor leaves ── */
  const S = { start: Date.now(), visibleMs: 0, lastVisible: Date.now(), sections: {}, videos: {}, opened: [], timeline: [] };
  const elapsed = () => Math.round((Date.now() - S.start) / 1000);
  function track(event, props = {}, note) {
    if (note) S.timeline.push(`${fmt(elapsed())} ${note}`);
    const p = ph();
    if (p) p.capture(event, Object.assign({ portal_company: config.company, portal_slug: config.slug }, props));
  }
  if (ph()) ph().register({ portal_company: config.company, portal_slug: config.slug });
  track("portal_opened", { referrer: document.referrer || null }, "Opened the portal");

  /* ── Answers ── */
  let Q = [], cur = 0, clock = null;
  const video = document.createElement("video");
  video.playsInline = true; video.preload = "metadata";

  // Placeholder mode: a real-time clock standing in for a video that hasn't been recorded yet.
  function makeClock(duration) {
    let t = 0, timer = null, playing = false;
    const api = {
      get currentTime() { return t; }, set currentTime(v) { t = Math.max(0, Math.min(v, duration)); emit("timeupdate"); },
      get duration() { return duration; }, get paused() { return !playing; },
      play() { if (playing) return; playing = true; emit("play"); timer = setInterval(() => { t = Math.min(t + 0.25, duration); emit("timeupdate"); if (t >= duration) { api.pause(); emit("ended"); } }, 250); },
      pause() { if (!playing) return; playing = false; clearInterval(timer); emit("pause"); },
      handlers: {}, on(ev, fn) { (api.handlers[ev] = api.handlers[ev] || []).push(fn); }
    };
    function emit(ev) { (api.handlers[ev] || []).forEach(fn => fn()); }
    return api;
  }
  const media = () => Q[cur].video ? video : clock;

  function vstate(i) { return S.videos[Q[i].id] = S.videos[Q[i].id] || { title: Q[i].short, plays: 0, maxPct: 0, watchedSec: 0, milestones: [] }; }

  function renderRail() {
    $("rail").innerHTML = Q.map((q, i) => {
      const v = S.videos[q.id] || { maxPct: 0 };
      return `<button class="q" role="listitem" data-i="${i}" aria-current="${i === cur}">
        <span class="n"><span>${esc(label(i))} · ${fmt(q.duration)}</span>${v.maxPct >= 95 ? '<span class="w">✓ watched</span>' : ""}</span>
        <span class="tt">${esc(q.short)}</span><span class="prog"><i style="width:${v.maxPct}%"></i></span></button>`;
    }).join("");
    $("rail").querySelectorAll(".q").forEach(b => b.onclick = () => {
      const i = +b.dataset.i; track("question_selected", { question: Q[i].id, index: i + 1 }, `Selected ${label(i)}`); select(i, true);
    });
  }
  function renderTranscript() {
    const q = Q[cur];
    $("tHead").textContent = q.transcriptStatus === "outline" ? "Outline · the full transcript follows the recording" : "Transcript · click a line to jump";
    $("tbody").innerHTML = q.lines.map(([s, txt]) => `<div class="line" data-s="${s}"><span class="ts">${fmt(s)}</span><span>${esc(txt)}</span></div>`).join("");
    $("tbody").querySelectorAll(".line").forEach(l => l.onclick = () => {
      track("transcript_line_clicked", { question: q.id, at: +l.dataset.s }, `${label(cur)}: jumped to ${fmt(+l.dataset.s)} from the transcript`);
      media().currentTime = +l.dataset.s; if (media().paused) media().play();
    });
  }
  function update() {
    const m = media(), q = Q[cur], d = m.duration || q.duration, t = m.currentTime;
    $("fill").style.width = `${(t / d) * 100}%`;
    $("time").textContent = `${fmt(t)} / ${fmt(d)}`;
    let active = 0; q.lines.forEach(([s], i) => { if (t >= s) active = i; });
    $("tbody").querySelectorAll(".line").forEach((l, i) => {
      const on = i === active && (t > 0 || !m.paused);
      if (on && !l.classList.contains("active")) l.scrollIntoView({ block: "nearest", behavior: "smooth" });
      l.classList.toggle("active", on);
    });
    const v = vstate(cur), pct = Math.round((t / d) * 100);
    if (pct > v.maxPct) {
      v.maxPct = pct;
      [25, 50, 75, 100].forEach(ms => { if (pct >= ms && !v.milestones.includes(ms)) { v.milestones.push(ms); track("video_progress", { question: q.id, percent: ms }); if (ms % 50 === 0) renderRail(); } });
    }
  }
  function setIcons() {
    const m = media(), playing = !m.paused;
    $("bigPlay").hidden = playing || m.currentTime > 0;
    $("playIcon").innerHTML = playing ? '<path d="M4 2h3v12H4zM9 2h3v12H9z"/>' : '<path d="M4 2l10 6-10 6z"/>';
    $("play").setAttribute("aria-label", playing ? "Pause" : "Play");
  }
  let lastTick = 0;
  function bind(m) {
    const on = (ev, fn) => m.on ? m.on(ev, fn) : m.addEventListener(ev, fn);
    on("timeupdate", () => { const now = m.currentTime; if (!m.paused && now > lastTick && now - lastTick < 2) vstate(cur).watchedSec += now - lastTick; lastTick = now; update(); });
    on("play", () => { const v = vstate(cur); v.plays++; setIcons(); wake(); track("video_played", { question: Q[cur].id, index: cur + 1, from: Math.round(m.currentTime), placeholder: !Q[cur].video }, `${label(cur)} "${Q[cur].short}": played${m.currentTime > 1 ? ` from ${fmt(m.currentTime)}` : ""}`); });
    on("pause", () => { setIcons(); stage.classList.remove("idle"); clearTimeout(idleTimer); if (m.currentTime < (m.duration || Q[cur].duration)) track("video_paused", { question: Q[cur].id, at: Math.round(m.currentTime) }, `${label(cur)}: paused at ${fmt(m.currentTime)}`); });
    on("ended", () => {
      track("video_completed", { question: Q[cur].id, index: cur + 1 }, `${label(cur)}: watched to the end`); renderRail(); setIcons();
      if (cur < Q.length - 1) setTimeout(() => select(cur + 1, true), 1200);
    });
  }
  bind(video);
  function select(i, autoplay) {
    const prev = Q[cur] && (Q[cur].video ? video : clock);
    if (prev && !prev.paused) prev.pause();
    cur = i; lastTick = 0;
    const q = Q[i], stage = $("stage");
    stage.classList.toggle("has-video", !!q.video);
    if (q.video) {
      if (!video.isConnected) stage.prepend(video);
      video.src = mediaUrl(q.video); if (q.poster) video.poster = mediaUrl(q.poster);
    } else {
      video.removeAttribute("src"); video.remove();
      clock = makeClock(q.duration); bind(clock);
    }
    $("qtitle").textContent = q.title;
    $("counter").textContent = label(i);
    $("pos").textContent = `${i + 1} of ${Q.length}`;
    $("prev").disabled = i === 0; $("next").disabled = i === Q.length - 1;
    renderRail(); renderTranscript(); update(); setIcons();
    if (autoplay) media().play();
  }
  const toggle = () => media().paused ? media().play() : media().pause();

  /* Overlays hide while playing; any movement or tap brings them back */
  const stage = $("stage");
  let idleTimer;
  function wake() {
    stage.classList.remove("idle"); clearTimeout(idleTimer);
    if (Q.length && !media().paused) idleTimer = setTimeout(() => stage.classList.add("idle"), 2500);
  }
  ["mousemove", "touchstart", "keydown"].forEach(ev => stage.addEventListener(ev, wake, { passive: true }));
  stage.addEventListener("click", e => {
    if (e.target.closest("button, .bar")) return;
    if (stage.classList.contains("idle")) return wake();   // first tap on a hidden overlay just reveals it
    toggle();
  });

  /* Full screen: the whole player where supported, the native iOS player otherwise */
  $("fsBtn").onclick = () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    track("fullscreen_entered", { question: Q[cur].id }, `${label(cur)}: went full screen`);
    if (stage.requestFullscreen) stage.requestFullscreen();
    else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
    else if (Q[cur].video && video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  };

  /* Theater view */
  function theater(on) {
    $("player").classList.toggle("theater", on); document.body.classList.toggle("theater", on);
    $("theaterBtn").setAttribute("aria-label", on ? "Exit theater view" : "Theater view");
    if (on) track("theater_opened", { question: Q[cur].id }, `${label(cur)}: opened theater view`);
    wake();
  }
  $("theaterBtn").onclick = () => theater(!$("player").classList.contains("theater"));
  $("theaterClose").onclick = () => theater(false);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && $("player").classList.contains("theater")) theater(false); });
  $("bigPlay").onclick = toggle; $("play").onclick = toggle;
  $("prev").onclick = () => { track("question_skipped", { direction: "back", to: cur }, `Skipped back to ${label(cur - 1)}`); select(cur - 1, !media().paused); };
  $("next").onclick = () => { track("question_skipped", { direction: "ahead", to: cur + 2 }, `Skipped ahead to ${label(cur + 1)}`); select(cur + 1, !media().paused); };
  $("bar").onclick = e => {
    const r = e.currentTarget.getBoundingClientRect(), d = media().duration || Q[cur].duration, s = ((e.clientX - r.left) / r.width) * d;
    track("video_scrubbed", { question: Q[cur].id, to: Math.round(s) }, `${label(cur)}: scrubbed to ${fmt(s)}`); media().currentTime = s;
  };
  $("copyT").onclick = () => {
    track("transcript_copied", { question: Q[cur].id }, `${label(cur)}: copied the transcript`);
    navigator.clipboard?.writeText(Q[cur].lines.map(l => l[1]).join(" ")).then(() => { $("copyT").textContent = "Copied"; setTimeout(() => $("copyT").textContent = "Copy", 1500); }).catch(() => {});
  };
  function goQuestion(ref) {
    const i = isNaN(ref) ? Q.findIndex(q => q.id === ref) : +ref;
    if (i >= 0) { select(i, false); $("answers").scrollIntoView({ behavior: "smooth" }); }
  }

  fetch(config.library).then(r => r.json()).then(lib => {
    Q = config.questions.map(id => Object.assign({ id }, lib.questions[id]));
    select(0, false);
  });

  /* ── Generic click tracking: data-track="event" data-label="what to show in the timeline" ── */
  document.addEventListener("click", e => {
    const el = e.target.closest("[data-track]"); if (!el) return;
    const label = el.dataset.label || el.textContent.trim().slice(0, 60);
    S.opened.push(label);
    track(el.dataset.track, { label, href: el.getAttribute("href") || null }, `Opened ${label}`);
  });
  document.querySelectorAll("[data-goto-q]").forEach(b => b.addEventListener("click", () => {
    track("question_link_clicked", { question: b.dataset.gotoQ, from: b.closest("[data-sec]")?.dataset.sec }, `Jumped to ${b.dataset.gotoQ} from ${b.closest("[data-sec]")?.dataset.sec}`);
    goQuestion(b.dataset.gotoQ);
  }));
  document.querySelectorAll("details[data-answer]").forEach(d => d.addEventListener("toggle", () => {
    if (d.open) track("written_answer_opened", { question: d.dataset.answer }, `Read the written answer to ${d.querySelector(".qn").textContent}`);
  }));
  document.querySelectorAll("[data-goto-sec]").forEach(b => b.addEventListener("click", () => $(b.dataset.gotoSec).scrollIntoView({ behavior: "smooth" })));

  /* ── Inline reference videos (e.g. a recorded reference) ── */
  document.querySelectorAll("[data-inline-poster]").forEach(img => { img.src = mediaUrl(img.dataset.inlinePoster); });
  document.querySelectorAll("[data-inline-video]").forEach(box => {
    box.addEventListener("click", () => {
      if (box.classList.contains("playing")) return;
      const name = box.dataset.name, v = document.createElement("video");
      v.src = mediaUrl(box.dataset.inlineVideo); v.controls = true; v.playsInline = true; v.autoplay = true;
      box.classList.add("playing"); box.appendChild(v);
      const st = S.videos[name] = { title: name, plays: 0, maxPct: 0, watchedSec: 0, milestones: [] };
      v.addEventListener("play", () => { st.plays++; track("inline_video_played", { video: name }, `Played ${name}`); });
      v.addEventListener("timeupdate", () => {
        const pct = Math.round((v.currentTime / (v.duration || 1)) * 100); if (pct > st.maxPct) st.maxPct = pct;
        [25, 50, 75, 100].forEach(ms => { if (pct >= ms && !st.milestones.includes(ms)) { st.milestones.push(ms); track("video_progress", { video: name, percent: ms }); } });
      });
    }, { once: false });
  });

  /* ── Section dwell time: counts seconds while a section is on screen and the tab is visible ── */
  const visible = new Set();
  const io = new IntersectionObserver(es => es.forEach(e => e.isIntersecting ? visible.add(e.target.dataset.sec) : visible.delete(e.target.dataset.sec)), { threshold: 0.3 });
  document.querySelectorAll("[data-sec]").forEach(s => io.observe(s));
  setInterval(() => {
    if (document.hidden) return;
    visible.forEach(k => {
      if (!S.sections[k]) track("section_viewed", { section: k }, `Scrolled to ${k}`);
      S.sections[k] = (S.sections[k] || 0) + 1;
    });
  }, 1000);

  /* ── Visit summary: sent each time the tab is hidden or closed, only if something changed ── */
  let summaries = 0, lastSent = "";
  function sendSummary(reason) {
    if (!document.hidden && reason !== "pagehide") return;
    const videos = Object.values(S.videos).map(v => ({ title: v.title, plays: v.plays, max_percent: v.maxPct, watched_seconds: Math.round(v.watchedSec) }));
    const body = {
      reason, summary_number: summaries + 1,
      time_on_page_seconds: elapsed(), active_seconds: Math.round(S.visibleMs / 1000),
      sections_seconds: S.sections, videos, videos_completed: videos.filter(v => v.max_percent >= 95).length,
      opened: [...new Set(S.opened)], timeline: S.timeline.slice(-60).join("\n"),
      replay_url: window.posthog?.get_session_replay_url ? window.posthog.get_session_replay_url({ withTimestamp: false }) : null
    };
    const key = JSON.stringify([body.sections_seconds, body.videos, body.opened, S.timeline.length]);
    if (key === lastSent) return;
    lastSent = key; summaries++;
    const p = ph(); if (p) p.capture("portal_summary", Object.assign({ portal_company: config.company, portal_slug: config.slug }, body), { transport: "sendBeacon" });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { S.visibleMs += Date.now() - S.lastVisible; sendSummary("hidden"); }
    else S.lastVisible = Date.now();
  });
  window.addEventListener("pagehide", () => { if (!document.hidden) S.visibleMs += Date.now() - S.lastVisible; sendSummary("pagehide"); });
})();
