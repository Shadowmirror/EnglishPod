(function () {
  'use strict';

  const core = window.PlayerCore;
  const audio = document.getElementById('audio');
  const playlist = document.getElementById('playlist');
  const info = document.getElementById('playerInfo');
  const status = document.getElementById('playerStatus');
  const srt = document.getElementById('srtContainer');
  const txt = document.getElementById('txtContainer');
  const md = document.getElementById('mdContainer');
  const chinese = document.getElementById('showChinese');
  const sentenceLoop = document.getElementById('sentenceLoop');
  const retainHighlight = document.getElementById('retainHighlight');
  const scopeControls = [...document.querySelectorAll('input[name="scope"]')];
  const playControls = [...document.querySelectorAll('input[name="playMode"]')];
  const tabButtons = [...document.querySelectorAll('.tab-btn')];
  const tabPanes = [...document.querySelectorAll('.tab-pane')];

  let manifest = [];
  let lesson = null;
  let episodeIndex = -1;
  let scope = 'full';
  let selectedId = null;
  let activeId = null;
  let loadToken = 0;
  let playToken = 0;
  let wantedPlayback = false;
  let seeking = false;
  let changingTime = false;
  let finishing = false;
  let raf = 0;
  let pendingSeek = null;
  let lessonController = null;
  const lessonCache = new Map();
  const markdownCache = new Map();

  // Preferences belong to this browser/origin, never to the server.
  let preferences = {};
  try { preferences = JSON.parse(localStorage.getItem('englishPodPreferences')) || {}; } catch (_) {}
  function savePreferences() {
    try {
      localStorage.setItem('englishPodPreferences', JSON.stringify({
        chinese: chinese.checked, retainHighlight: retainHighlight.checked,
        sentenceLoop: sentenceLoop.checked, scope, playMode: playMode(), speed: audio.playbackRate
      }));
    } catch (_) {} // Private mode/storage restrictions must not stop playback.
  }
  chinese.checked = preferences.chinese === true;
  retainHighlight.checked = preferences.retainHighlight !== false;
  sentenceLoop.checked = preferences.sentenceLoop === true;
  scope = preferences.scope === 'dialog' ? 'dialog' : 'full';
  scopeControls.forEach(control => { control.checked = control.value === scope; });
  const savedMode = ['sequential', 'loop', 'listLoop'].includes(preferences.playMode) ? preferences.playMode : 'sequential';
  playControls.forEach(control => { control.checked = control.value === savedMode; });
  const savedSpeed = Number(preferences.speed);
  audio.defaultPlaybackRate = Number.isFinite(savedSpeed) && savedSpeed >= 0.5 && savedSpeed <= 2 ? savedSpeed : 1;
  audio.playbackRate = audio.defaultPlaybackRate;
  audio.controls = false;

  function desktopState() {
    const visible = lesson ? core.visibleSegments(lesson, scope) : [];
    const index = core.findHighlightSegment(visible, audio.currentTime, retainHighlight.checked);
    const previous = [...visible].reverse().find(segment => segment.start < audio.currentTime - 0.05 && segment.id !== visible[index]?.id);
    const next = visible.find(segment => segment.start > audio.currentTime + 0.05);
    return {
      title: `${info.textContent} · ${scope === 'dialog' ? '对话' : '完整节目'}`,
      ready: Boolean(lesson), scope, time: audio.currentTime, speed: audio.playbackRate, sentence: visible[index], segments: visible, index, chinese: chinese.checked,
      paused: audio.paused, loop: sentenceLoop.checked, playMode: playMode(),
      canPreviousLesson: episodeIndex > 0 || playMode() === 'listLoop',
      canNextLesson: episodeIndex < manifest.length - 1 || playMode() === 'listLoop',
      canPrevious: Boolean(previous), canNext: Boolean(next), previous, next
    };
  }

  const desktop = window.DesktopSubtitles({
    button: document.getElementById('desktopSubtitles'), getState: desktopState,
    onTick: synchronize, onError: message => setStatus(message, true),
    onAction(action, value) {
      if (!lesson) return;
      const state = desktopState();
      if (action === 'speed') {
        const rate = Number(value);
        if (Number.isFinite(rate) && rate >= 0.5 && rate <= 2) {
          audio.defaultPlaybackRate = rate;
          audio.playbackRate = rate;
          savePreferences();
          desktop.render();
        }
        return;
      }
      if (action === 'previousLesson' || action === 'nextLesson') {
        let next = episodeIndex + (action === 'previousLesson' ? -1 : 1);
        if (playMode() === 'listLoop') next = (next + manifest.length) % manifest.length;
        if (next >= 0 && next < manifest.length) selectEpisode(next, true);
        return;
      }
      if (action === 'scope') {
        const target = scopeControls.find(control => control.value === (scope === 'dialog' ? 'full' : 'dialog'));
        target.checked = true;
        target.dispatchEvent(new Event('change'));
        return;
      }
      if (action === 'mode') {
        const modes = ['sequential', 'loop', 'listLoop'];
        const nextMode = modes[(modes.indexOf(playMode()) + 1) % modes.length];
        playControls.find(control => control.value === nextMode).checked = true;
        savePreferences();
        desktop.render();
      }
      if (action === 'play') { if (audio.paused) requestPlay(); else stopAudio(); }
      if (action === 'previous' && state.previous) selectSentence(state.previous.id);
      if (action === 'next' && state.next) selectSentence(state.next.id);
      if (action === 'translation') { chinese.checked = !chinese.checked; chinese.dispatchEvent(new Event('change')); }
      if (action === 'loop') {
        if (!sentenceLoop.checked && state.sentence) selectedId = state.sentence.id;
        sentenceLoop.checked = !sentenceLoop.checked;
        sentenceLoop.dispatchEvent(new Event('change'));
      }
    }
  });

  function setStatus(message, error) {
    status.textContent = message;
    status.classList.toggle('error', Boolean(error));
  }

  function setLoading(loading) {
    audio.controls = !loading;
    audio.setAttribute('aria-disabled', String(loading));
    scopeControls.forEach(control => { control.disabled = loading; });
    playControls.forEach(control => { control.disabled = loading; });
    sentenceLoop.disabled = loading;
    chinese.disabled = loading;
    retainHighlight.disabled = loading;
    desktop.render();
  }

  function currentRange() {
    return core.playbackRange(lesson, scope, selectedId, sentenceLoop.checked);
  }

  function playMode() {
    return playControls.find(control => control.checked)?.value || 'sequential';
  }

  function isCurrent(token) {
    return token === loadToken;
  }

  function setTime(time) {
    if (!Number.isFinite(time)) return;
    if (audio.readyState === 0) {
      pendingSeek = time;
      return;
    }
    if (core.sameTime(audio.currentTime, time)) return;
    changingTime = true;
    try { audio.currentTime = time; }
    catch (error) { setStatus('音频尚未就绪，请稍后重试。', true); }
    finally { changingTime = false; }
  }

  function stopAudio() {
    wantedPlayback = false;
    playToken++;
    if (!audio.paused) audio.pause();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function requestPlay() {
    if (!lesson) return;
    wantedPlayback = true;
    const episodeToken = loadToken;
    const requestToken = ++playToken;
    let promise;
    try { promise = audio.play(); }
    catch (error) { onPlayError(error, episodeToken, requestToken); return; }
    Promise.resolve(promise).then(() => {
      // A superseded play() may resolve after a newer sentence or episode has started.
      // Only the current request may decide to stop playback.
      if (requestToken !== playToken) {
        if (!wantedPlayback && !audio.paused) audio.pause();
        return;
      }
      if (!isCurrent(episodeToken) || !wantedPlayback) audio.pause();
    }).catch(error => onPlayError(error, episodeToken, requestToken));
  }

  function onPlayError(error, episodeToken, requestToken) {
    if (!isCurrent(episodeToken) || requestToken !== playToken || !wantedPlayback) return;
    wantedPlayback = false;
    setStatus('无法播放音频。请检查文件，或点击音频控件重试。', true);
  }

  function isValidLesson(data, episode) {
    if (!data || data.version !== 1 || data.number !== episode.number ||
        !Array.isArray(data.segments) || !data.segments.length ||
        !data.dialog || !Array.isArray(data.dialog.segmentIds) || !data.dialog.segmentIds.length ||
        typeof data.audio !== 'string' || !data.audio ||
        !Number.isFinite(data.duration) || data.duration <= 0 ||
        !Number.isFinite(data.dialog.start) || !Number.isFinite(data.dialog.end) ||
        data.dialog.start < 0 || data.dialog.end <= data.dialog.start || data.dialog.end > data.duration + 0.25) return false;
    const ids = new Set();
    let previousEnd = 0;
    for (const segment of data.segments) {
      if (!Number.isInteger(segment.id) || ids.has(segment.id) ||
          !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
          segment.start < previousEnd - 0.01 || segment.end <= segment.start ||
          segment.end > data.duration + 0.25 ||
          typeof segment.en !== 'string' || !segment.en.trim() ||
          typeof segment.zh !== 'string' || !segment.zh.trim()) return false;
      ids.add(segment.id);
      previousEnd = segment.end;
    }
    if (data.dialog.segmentIds.some(id => !ids.has(id))) return false;
    const selected = core.visibleSegments(data, 'dialog');
    return selected.length > 0 &&
      selected[0].start >= data.dialog.start - 0.1 &&
      selected[selected.length - 1].end <= data.dialog.end + 0.1;
  }

  function buildPlaylist() {
    playlist.replaceChildren();
    if (!manifest.length) {
      setStatus('播放列表为空，请检查 manifest.json。', true);
      return;
    }
    manifest.forEach((episode, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'playlist-item';
      const number = document.createElement('span');
      number.className = 'num';
      number.textContent = episode.number;
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = episode.title;
      item.append(number, title);
      item.addEventListener('click', () => selectEpisode(index, false));
      item.addEventListener('dblclick', () => {
        if (episodeIndex === index && lesson) requestPlay();
        else selectEpisode(index, true);
      });
      playlist.append(item);
    });
  }

  function markEpisode() {
    [...playlist.children].forEach((item, index) => {
      item.classList.toggle('active', index === episodeIndex);
      item.classList.toggle('playing', index === episodeIndex && wantedPlayback && !audio.paused);
    });
  }

  async function selectEpisode(index, autoplay) {
    const episode = manifest[index];
    if (!episode) return;
    const token = ++loadToken;
    if (lessonController) lessonController.abort();
    lessonController = new AbortController();
    stopAudio();
    audio.removeAttribute('src');
    audio.load();
    pendingSeek = null;
    lesson = null;
    episodeIndex = index;
    selectedId = null;
    activeId = null;
    srt.replaceChildren();
    txt.replaceChildren();
    md.replaceChildren();
    info.textContent = `${episode.number} ${episode.title}`;
    markEpisode();
    setLoading(true);
    setStatus(`正在加载 ${episode.number} 的双语课文…`);

    try {
      let data = lessonCache.get(episode.number);
      if (!data) {
        const response = await fetch(`lessons/englishpod_${episode.number}.json`, { signal: lessonController.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = await response.json();
        if (!isValidLesson(data, episode)) throw new Error('invalid lesson');
        lessonCache.set(episode.number, data);
      }
      if (!isCurrent(token)) return;
      lesson = data;
      try { localStorage.setItem('englishPodLastLesson', episode.number); } catch (_) {}
      audio.src = encodeURI(data.audio);
      audio.load();
      setLoading(false);
      renderSentences();
      if (scope === 'dialog') setTime(data.dialog.start);
      setStatus(`已加载 ${episode.number} · ${data.segments.length} 句`);
      if (activeTab() === 'md') loadMarkdown(episode, token);
      if (autoplay) requestPlay();
    } catch (error) {
      if (!isCurrent(token)) return;
      lesson = null;
      setStatus(`无法加载 ${episode.number} 的课文，请检查 lesson JSON 后重选节目。`, true);
    }
  }

  function sentenceButton(segment, kind) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = kind === 'srt' ? 'sentence srt-line' : 'sentence txt-line';
    button.dataset.id = String(segment.id);
    button.setAttribute('aria-label', `${segment.en}。点击播放此句`);
    const english = document.createElement('span');
    english.className = 'en';
    english.textContent = segment.en;
    const translation = document.createElement('span');
    translation.className = 'zh';
    translation.textContent = segment.zh;
    translation.hidden = !chinese.checked;
    button.append(english, translation);
    button.addEventListener('click', () => selectSentence(segment.id));
    return button;
  }

  function renderSentences() {
    srt.replaceChildren();
    txt.replaceChildren();
    if (!lesson) return;
    const visible = core.visibleSegments(lesson, scope);
    for (const segment of visible) {
      srt.append(sentenceButton(segment, 'srt'));
      txt.append(sentenceButton(segment, 'txt'));
    }
    updateHighlight();
  }

  function updateHighlight() {
    if (!lesson) return;
    const visible = core.visibleSegments(lesson, scope);
    const segmentIndex = core.findHighlightSegment(visible, audio.currentTime, retainHighlight.checked);
    const nextId = segmentIndex < 0 ? null : visible[segmentIndex].id;
    desktop.render();
    for (const button of document.querySelectorAll('.sentence')) {
      const id = Number(button.dataset.id);
      button.classList.toggle('active', id === nextId);
      button.classList.toggle('selected', sentenceLoop.checked && id === selectedId);
    }
    if (nextId !== activeId) {
      activeId = nextId;
      const pane = document.querySelector('.tab-pane.active');
      const active = pane?.querySelector(`.sentence[data-id="${nextId}"]`);
      if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
    }
  }

  function selectSentence(id) {
    if (!lesson) return;
    const segment = core.visibleSegments(lesson, scope).find(item => item.id === id);
    if (!segment) return;
    selectedId = id;
    setTime(segment.start);
    updateHighlight();
    requestPlay();
  }

  function finishRange(range, naturalEnd) {
    if (finishing || !lesson) return;
    finishing = true;
    try {
      if (!naturalEnd && audio.paused) {
        setTime(range.start);
        return;
      }
      const action = core.endAction(range.kind, playMode());
      if (action === 'restart') {
        setTime(range.start);
        if (naturalEnd || (audio.paused && wantedPlayback)) requestPlay();
        updateHighlight();
      } else {
        const next = episodeIndex + 1;
        stopAudio();
        if (next < manifest.length) selectEpisode(next, true);
        else if (playMode() === 'listLoop') selectEpisode(0, true);
        else {
          setTime(range.start);
          setStatus('播放列表已结束。');
        }
      }
    } finally { finishing = false; }
  }

  function synchronize() {
    if (!lesson || changingTime || seeking || finishing) return;
    const range = currentRange();
    if (range.kind !== 'full') {
      if (audio.currentTime < range.start && !core.sameTime(audio.currentTime, range.start)) {
        setTime(range.start);
        updateHighlight();
        return;
      }
      if (audio.currentTime >= range.end) {
        finishRange(range);
        return;
      }
    }
    updateHighlight();
  }

  function tick() {
    raf = 0;
    synchronize();
    if (lesson && !audio.paused) raf = requestAnimationFrame(tick);
  }

  function activeTab() {
    return tabButtons.find(button => button.classList.contains('active'))?.dataset.tab || 'srt';
  }

  async function loadMarkdown(episode, token) {
    if (!episode.md) { md.textContent = '本期暂无知识讲解。'; return; }
    if (markdownCache.has(episode.number)) { md.innerHTML = markdownCache.get(episode.number); return; }
    md.textContent = '正在加载知识讲解…';
    try {
      const response = await fetch(episode.md);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const source = await response.text();
      if (!isCurrent(token)) return;
      if (!window.marked) throw new Error('Markdown renderer unavailable');
      const html = window.marked.parse(source);
      markdownCache.set(episode.number, html);
      md.innerHTML = html;
    } catch (error) {
      if (isCurrent(token)) md.textContent = '无法加载知识讲解。';
    }
  }

  chinese.addEventListener('change', () => {
    savePreferences();
    document.querySelectorAll('.sentence .zh').forEach(element => { element.hidden = !chinese.checked; });
    desktop.render();
  });

  retainHighlight.addEventListener('change', () => { savePreferences(); updateHighlight(); });
  playControls.forEach(control => control.addEventListener('change', () => { savePreferences(); desktop.render(); }));

  sentenceLoop.addEventListener('change', () => {
    savePreferences();
    if (!lesson) return;
    const range = currentRange();
    const clamped = core.clampTime(audio.currentTime, range);
    if (!core.sameTime(clamped, audio.currentTime)) setTime(clamped);
    if (sentenceLoop.checked && selectedId == null) setStatus('单句循环已开启，点击任一句开始循环。');
    else setStatus(sentenceLoop.checked ? '正在循环所选句子。' : '已关闭单句循环。');
    synchronize();
  });

  scopeControls.forEach(control => control.addEventListener('change', () => {
    if (!control.checked) return;
    scope = control.value;
    savePreferences();
    if (!lesson) return;
    const first = core.visibleSegments(lesson, scope)[0];
    selectedId = first?.id ?? null;
    if (first) setTime(first.start);
    renderSentences();
    synchronize();
    setStatus(scope === 'dialog' ? '仅播放本期对话片段。' : '播放完整节目。');
  }));

  tabButtons.forEach(button => button.addEventListener('click', () => {
    tabButtons.forEach(other => other.classList.toggle('active', other === button));
    tabPanes.forEach(pane => pane.classList.toggle('active', pane.id === `tab-${button.dataset.tab}`));
    if (button.dataset.tab === 'md' && lesson) loadMarkdown(manifest[episodeIndex], loadToken);
    updateHighlight();
  }));

  audio.addEventListener('play', () => {
    if (!lesson) { audio.pause(); return; }
    wantedPlayback = true;
    markEpisode();
    desktop.render();
    if (!raf) raf = requestAnimationFrame(tick);
  });
  audio.addEventListener('pause', () => {
    wantedPlayback = false;
    playToken++;
    markEpisode();
    desktop.render();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  });
  audio.addEventListener('ratechange', () => {
    if (audio.defaultPlaybackRate !== audio.playbackRate) audio.defaultPlaybackRate = audio.playbackRate;
    savePreferences();
    desktop.render();
  });
  audio.addEventListener('timeupdate', synchronize);
  audio.addEventListener('loadedmetadata', () => {
    if (!lesson) return;
    const target = pendingSeek == null ? core.clampTime(audio.currentTime, currentRange()) : pendingSeek;
    pendingSeek = null;
    if (!core.sameTime(target, audio.currentTime)) setTime(target);
  });
  audio.addEventListener('seeking', () => { seeking = true; });
  audio.addEventListener('seeked', () => {
    seeking = false;
    if (!lesson) return;
    const clamped = core.clampTime(audio.currentTime, currentRange());
    if (!core.sameTime(clamped, audio.currentTime)) setTime(clamped);
    updateHighlight();
  });
  audio.addEventListener('ended', () => {
    if (lesson) finishRange(currentRange(), true);
  });
  audio.addEventListener('error', () => {
    if (lesson) setStatus('音频文件无法加载，请检查 MP3 路径。', true);
  });

  // Optional deployment files stay local; expose links only when both exist.
  const certificateLinks = [...document.querySelectorAll('.local-certificate-link')];
  Promise.all(certificateLinks.map(link => fetch(link.getAttribute('href'), { method: 'HEAD' })))
    .then(responses => {
      if (responses.every(response => response.ok)) {
        certificateLinks.forEach(link => link.classList.remove('hidden'));
      }
    }).catch(() => {});

  setLoading(true);
  setStatus('正在加载播放列表…');
  fetch('manifest.json').then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }).then(data => {
    if (!Array.isArray(data)) throw new Error('invalid manifest');
    manifest = data;
    buildPlaylist();
    if (manifest.length) {
      let savedNumber = null;
      try { savedNumber = localStorage.getItem('englishPodLastLesson'); } catch (_) {}
      const savedIndex = manifest.findIndex(episode => episode.number === savedNumber);
      selectEpisode(savedIndex >= 0 ? savedIndex : 0, false);
    }
  }).catch(() => setStatus('无法加载播放列表，请检查 manifest.json。', true));
})();
