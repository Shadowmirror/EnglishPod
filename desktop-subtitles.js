(function () {
  'use strict';
  window.DesktopSubtitles = function ({ button, getState, onAction, onTick, onError }) {
    let pip = null;
    let frame = 0;
    let opening = false;
    let elements = null;
    let lineCount = 1;
    let lastContent = '';
    let lastFit = '';
    let previousView = null;
    let alignment = 'left';
    let background = '#172033';
    let foreground = '#f8fafc';
    let toolbarHidden = false;
    let horizontalScroll = true;
    try {
      lineCount = Number(localStorage.getItem('desktopLineCount')) || 1;
      alignment = localStorage.getItem('desktopAlignment') || alignment;
      background = localStorage.getItem('desktopBackground') || background;
      foreground = localStorage.getItem('desktopForeground') || foreground;
      toolbarHidden = localStorage.getItem('desktopToolbarHidden') === 'true';
      horizontalScroll = localStorage.getItem('desktopHorizontalScroll') !== 'false';
    } catch (_) {}
    lineCount = [1, 2, 3].includes(lineCount) ? lineCount : 1;
    alignment = ['left', 'center', 'right'].includes(alignment) ? alignment : 'left';
    if (!/^#[0-9a-f]{6}$/i.test(background)) background = '#172033';
    if (!/^#[0-9a-f]{6}$/i.test(foreground)) foreground = '#f8fafc';

    function text(element, value) {
      if (element.textContent !== value) element.textContent = value;
    }

    function render() {
      if (!pip || pip.closed || !elements) return;
      const state = getState();
      text(elements.title, state.title);
      elements.title.title = state.title;
      const key = JSON.stringify([state.title, state.index, state.chinese, state.ready, lineCount, horizontalScroll]);
      if (key !== lastContent) {
        lastContent = key;
        const segments = state.segments || [];
        const start = !horizontalScroll && lineCount > 1 ? Math.max(0, state.index) : Math.max(0, Math.min(state.index - (lineCount === 3 ? 1 : 0), segments.length - lineCount));
        const rows = state.index < 0 ? [null] : segments.slice(start, start + lineCount);
        const area = elements.lyrics;
        const oldRows = [...area.children].filter(row => row.classList.contains('lyric'));
        const oldPositions = new Map(oldRows.map(row => [row.dataset.id, row.getBoundingClientRect()]));
        const smooth = horizontalScroll && previousView && previousView.title === state.title && previousView.count === lineCount &&
          previousView.chinese === state.chinese && previousView.index >= 0 && state.index >= 0 &&
          Math.abs(previousView.index - state.index) === 1 && !pip.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const direction = previousView && state.index < previousView.index ? -1 : 1;
        area.querySelectorAll('.departing').forEach(row => row.remove());
        oldRows.forEach(row => row.getAnimations().forEach(animation => animation.cancel()));
        const wanted = new Set(rows.map(segment => String(segment?.id ?? 'empty')));
        const departing = oldRows.filter(row => !wanted.has(row.dataset.id));
        const ghosts = smooth ? departing.map(row => ({ node: row.cloneNode(true), rect: oldPositions.get(row.dataset.id) })) : [];
        departing.forEach(row => row.remove());
        for (const segment of rows) {
          const id = String(segment?.id ?? 'empty');
          let row = oldRows.find(item => item.dataset.id === id);
          if (!row) {
            row = pip.document.createElement('section'); row.dataset.id = id;
            const line = pip.document.createElement('div'); line.className = 'line';
            const en = pip.document.createElement('div'); en.className = 'english';
            const zh = pip.document.createElement('div'); zh.className = 'chinese';
            line.append(en, zh); row.append(line);
          }
          const current = !segment || segment.id === state.sentence?.id;
          row.dataset.start = String(segment?.start ?? 0);
          row.dataset.end = String(segment?.end ?? 0);
          row.className = 'lyric' + (current ? ' current' : '');
          const en = row.querySelector('.english'), zh = row.querySelector('.chinese');
          en.textContent = segment?.en || (state.ready ? '当前没有字幕' : '正在加载课文…');
          zh.textContent = segment?.zh ? ' · ' + segment.zh : '';
          zh.hidden = !state.chinese || !segment;
          en.removeAttribute('id'); zh.removeAttribute('id');
          if (current) { en.id = 'desktopEnglish'; zh.id = 'desktopChinese'; }
          area.append(row);
        }
        fitRows();
        if (smooth) {
          const options = { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' };
          const bounds = area.getBoundingClientRect();
          for (const row of [...area.children]) {
            const rect = row.getBoundingClientRect();
            const old = oldPositions.get(row.dataset.id);
            const shift = old ? old.top - rect.top : direction * rect.height;
            row.animate([{ transform: `translateY(${shift}px)`, opacity: old ? getComputedStyle(row).opacity : 0 },
              { transform: 'translateY(0)', opacity: row.classList.contains('current') ? 1 : .55 }], options);
          }
          for (const ghost of ghosts) {
            const node = ghost.node;
            node.className = 'departing';
            node.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
            Object.assign(node.style, { position: 'absolute', pointerEvents: 'none', left: `${ghost.rect.left - bounds.left}px`,
              top: `${ghost.rect.top - bounds.top}px`, width: `${ghost.rect.width}px`, height: `${ghost.rect.height}px` });
            area.append(node);
            node.animate([{ transform: 'translateY(0)', opacity: .55 },
              { transform: `translateY(${-direction * ghost.rect.height}px)`, opacity: 0 }], options).finished.then(() => node.remove()).catch(() => node.remove());
          }
        }
        previousView = { title: state.title, count: lineCount, chinese: state.chinese, index: state.index };
      }
      const rootStyle = pip.document.documentElement.style;
      rootStyle.setProperty('--lyric-align', alignment);
      rootStyle.setProperty('--lyric-bg', background);
      rootStyle.setProperty('--lyric-fg', foreground);
      text(elements.play, state.paused ? '▶' : 'Ⅱ');
      elements.play.title = state.paused ? '播放' : '暂停';
      elements.play.setAttribute('aria-label', elements.play.title);
      const modeLabel = { sequential: '顺序播放', loop: '单曲循环', listLoop: '列表循环' }[state.playMode];
      text(elements.mode, { sequential: '→', loop: '↻₁', listLoop: '↻∞' }[state.playMode]);
      elements.mode.title = modeLabel + '（点击切换）';
      elements.mode.setAttribute('aria-label', elements.mode.title);
      elements.previousLesson.disabled = !state.ready || !state.canPreviousLesson;
      elements.nextLesson.disabled = !state.ready || !state.canNextLesson;
      elements.mode.disabled = !state.ready;
      elements.speed.disabled = !state.ready;
      if (elements.speed.value !== String(state.speed)) {
        if (![...elements.speed.options].some(option => option.value === String(state.speed))) {
          const option = pip.document.createElement('option'); option.value = String(state.speed); option.textContent = state.speed + '×'; elements.speed.append(option);
        }
        elements.speed.value = String(state.speed);
      }
      text(elements.scope, state.scope === 'dialog' ? '对' : '全');
      elements.scope.title = state.scope === 'dialog' ? '当前：对话；切换到完整节目' : '当前：完整节目；切换到对话';
      elements.scope.setAttribute('aria-label', elements.scope.title);
      elements.scope.setAttribute('aria-pressed', String(state.scope === 'dialog'));
      elements.scope.disabled = !state.ready;
      elements.loop.setAttribute('aria-pressed', String(state.loop));
      elements.translation.setAttribute('aria-pressed', String(state.chinese));
      elements.play.disabled = !state.ready;
      elements.loop.disabled = !state.ready;
      elements.translation.disabled = !state.ready;
      elements.previous.disabled = !state.canPrevious;
      elements.next.disabled = !state.canNext;
      fitRows();
      for (const row of elements.lyrics.querySelectorAll('.lyric')) {
        const start = Number(row.dataset.start), end = Number(row.dataset.end);
        const progress = end > start ? Math.max(0, Math.min(1, (state.time - start) / (end - start))) : 0;
        const line = row.querySelector('.line');
        line.style.transform = `translateX(${-(horizontalScroll ? Number(line.dataset.overflow || 0) : 0) * progress}px)`;
      }
    }

    function fitRows() {
      const area = elements.lyrics;
      const header = pip.document.querySelector('header');
      const settings = pip.document.getElementById('desktopSettings');
      const headerHeight = header.hidden ? 0 : header.getBoundingClientRect().height;
      settings.style.top = `${headerHeight}px`;
      // Controls are overlays: showing them never changes the subtitle viewport.
      area.style.marginTop = '0px';
      const fitKey = `${horizontalScroll}|${lastContent}|${area.clientWidth}|${area.clientHeight}`;
      if (fitKey === lastFit) return;
      lastFit = fitKey;
      const rows = [...area.children].filter(row => row.classList.contains('lyric'));
      const wrap = !horizontalScroll && lineCount > 1;
      area.classList.toggle('wrap', wrap);
      area.style.gridTemplateRows = wrap ? 'none' : `repeat(${Math.max(1, rows.length)}, minmax(0, 1fr))`;
      const style = pip.getComputedStyle(area);
      const rowHeight = (area.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - parseFloat(style.rowGap) * Math.max(0, rows.length - 1)) / Math.max(1, rows.length);
      const baseSize = Math.max(1, Math.min(48, area.clientWidth / 18, Math.max(1, rowHeight - 4) / 1.4));
      for (const row of rows) row.hidden = false;
      for (const row of rows) {
        row.style.setProperty('--lyric-size', `${baseSize}px`);
        const line = row.querySelector('.line');
        if (!horizontalScroll && lineCount === 1) {
          const width = line.scrollWidth;
          const size = Math.min(baseSize, baseSize * Math.max(1, row.clientWidth - 2) / Math.max(1, width));
          row.style.setProperty('--lyric-size', `${size}px`);
        }
        line.dataset.overflow = String(Math.max(0, line.scrollWidth - row.clientWidth));
      }
      if (wrap) {
        let remaining = lineCount;
        for (const row of rows) {
          const lineHeight = parseFloat(pip.getComputedStyle(row.querySelector('.english')).lineHeight);
          const occupied = Math.max(1, Math.ceil((row.getBoundingClientRect().height - 1) / lineHeight));
          // The current sentence is never truncated; following sentences must fit fully.
          const current = row.classList.contains('current');
          row.hidden = !current && occupied > remaining;
          if (!row.hidden) remaining = Math.max(0, remaining - occupied);
          else remaining = 0;
        }
        const current = area.querySelector('.current');
        if (current) area.scrollTop = current.offsetTop - parseFloat(style.paddingTop);
      } else { area.scrollTop = 0; }

    }

    function animate() {
      if (!pip || pip.closed) return;
      // Use the visible PiP window's scheduler when the opener tab is in the background.
      onTick();
      render();
      frame = pip.requestAnimationFrame(animate);
    }

    async function toggle() {
      if (opening) return;
      if (pip && !pip.closed) { pip.close(); return; }
      if (!window.isSecureContext) {
        onError('桌面字幕需要安全连接：本机请使用 localhost 或 127.0.0.1 的服务地址，其他设备请使用受信任的 HTTPS。');
        return;
      }
      if (!window.documentPictureInPicture?.requestWindow) {
        onError('当前浏览器不支持桌面字幕，请使用支持文档画中画的桌面 Chrome 或 Edge。');
        return;
      }
      opening = true;
      button.disabled = true;
      try {
        pip = await window.documentPictureInPicture.requestWindow({ width: 560, height: 260 });
        const doc = pip.document;
        doc.documentElement.lang = 'zh-CN';
        doc.title = 'EnglishPod 桌面字幕';
        const style = doc.createElement('style');
        style.textContent = `
          :root { color-scheme: dark; font-family: system-ui, "Microsoft YaHei", sans-serif; }
          html, body { height: 100%; overflow: hidden; }
          body { margin: 0; background: var(--lyric-bg,#172033); color: var(--lyric-fg,#f8fafc); display: flex; flex-direction: column; }
          header { position: fixed; top: 0; left: 0; right: 0; z-index: 4; display: flex; align-items: center; gap: 8px; background: transparent; color: #a5b4cf; font-size: 12px; padding: 6px 10px; flex-shrink: 0; }
          #desktopTitle { flex: 1; min-width: 40px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          #desktopSettings { position: fixed; top: 42px; right: 8px; left: 8px; z-index: 5; border-radius: 8px; flex-shrink: 0; max-height: 40vh; overflow: auto; background: transparent; color: #f8fafc; padding: 8px 12px; }
          #desktopSettings:not([hidden]) { display: flex; flex-wrap: wrap; gap: 12px; }
          input[type=color] { width: 32px; height: 26px; padding: 0; border: 0; cursor: pointer; }
          main { position: relative; min-height: 0; overflow: hidden; padding: clamp(2px,1vh,12px) clamp(4px,1.5vw,24px); flex: 1; text-align: var(--lyric-align,left); display: grid; gap: clamp(2px,1vh,12px); }
          .lyric, .departing { min-width: 0; min-height: 0; white-space: nowrap; overflow: hidden; display: flex; align-items: center; color: var(--lyric-fg,#f8fafc); opacity: .55; transition: opacity .2s; }
          .lyric.current { opacity: 1; }
          .line { width: max-content; min-width: 100%; flex-shrink: 0; white-space: nowrap; line-height: 1.4; }
          .english { display: inline-block; font-size: var(--lyric-size,23px); line-height: 1.4; letter-spacing: .015em; }
          .chinese { display: inline-block; font-size: calc(var(--lyric-size,23px) * .75); line-height: 1.4; letter-spacing: .015em; opacity: .8; }
          main.wrap { display: flex; flex-direction: column; overflow-y: auto; }
          .wrap .lyric { flex-shrink: 0; overflow: visible; }
          .wrap .line { width: 100%; min-width: 0; white-space: normal; overflow-wrap: anywhere; }
          .wrap .english, .wrap .chinese { display: inline; white-space: normal; }
          [hidden] { display: none !important; }
          nav { display: flex; align-items: center; gap: 3px; flex-shrink: 0; }
          label { font-size: 12px; display: inline-flex; align-items: center; gap: 5px; }
          select { padding: 6px; border-radius: 6px; }
          button { font: inherit; font-size: 13px; background: #293950; color: white; border: 1px solid #52647e; border-radius: 7px; padding: 0; width: 26px; height: 28px; cursor: pointer; }
          button[aria-pressed="true"] { background: #365fc4; border-color: #99b4ff; }
          button:disabled { opacity: .4; cursor: default; }
          #restoreToolbar { position: fixed; top: 4px; right: 4px; z-index: 5; opacity: .45; }
          #restoreToolbar:hover, #restoreToolbar:focus-visible { opacity: 1; }
          button:focus-visible { outline: 2px solid #a5c8ff; outline-offset: 2px; }
        `;
        doc.head.append(style);
        doc.body.innerHTML = '<header><span id="desktopTitle"></span><nav aria-label="播放控制"></nav></header><div id="desktopSettings" hidden></div><main id="desktopLyrics" aria-live="polite"></main>';
        lastContent = '';
        lastFit = '';
        previousView = null;
        elements = {
          title: doc.getElementById('desktopTitle'),
          lyrics: doc.getElementById('desktopLyrics')
        };
        for (const [action, label] of [['previousLesson', '上一课'], ['nextLesson', '下一课'], ['mode', '顺序播放（点击切换）'], ['scope', '切换到对话'], ['previous', '上一句'], ['play', '播放'], ['next', '下一句'], ['loop', '单句循环'], ['translation', '中文']]) {
          const control = doc.createElement('button');
          control.type = 'button';
          control.dataset.action = action;
          control.textContent = { previousLesson: '⇤', nextLesson: '⇥', mode: '→', scope: '全', previous: '⏮', play: '▶', next: '⏭', loop: '⟲', translation: '译' }[action];
          control.title = label;
          control.setAttribute('aria-label', label);
          control.addEventListener('click', () => { onAction(action); render(); });
          elements[action] = control;
          doc.querySelector('nav').append(control);
        }
        const speed = doc.createElement('select');
        speed.setAttribute('aria-label', '播放倍速'); speed.title = '播放倍速';
        for (const rate of [.5, .75, 1, 1.25, 1.5, 1.75, 2]) {
          const option = doc.createElement('option'); option.value = String(rate); option.textContent = rate + '×'; speed.append(option);
        }
        speed.addEventListener('change', () => { onAction('speed', speed.value); render(); });
        elements.speed = speed;
        doc.querySelector('nav').append(speed);
        const countLabel = doc.createElement('label');
        countLabel.textContent = '显示';
        const countSelect = doc.createElement('select');
        countSelect.setAttribute('aria-label', '显示句数');
        for (const count of [1, 2, 3]) {
          const option = doc.createElement('option');
          option.value = String(count); option.textContent = count + ' 行';
          countSelect.append(option);
        }
        countSelect.value = String(lineCount);
        countSelect.addEventListener('change', () => {
          lineCount = Number(countSelect.value);
          try { localStorage.setItem('desktopLineCount', String(lineCount)); } catch (_) {}
          render();
        });
        countLabel.append(countSelect);
        const settings = doc.getElementById('desktopSettings');
        settings.append(countLabel);
        const scrollLabel = doc.createElement('label');
        const scrollToggle = doc.createElement('input'); scrollToggle.type = 'checkbox'; scrollToggle.checked = horizontalScroll;
        scrollToggle.setAttribute('aria-label', '横向滚动');
        scrollToggle.addEventListener('change', () => {
          horizontalScroll = scrollToggle.checked;
          try { localStorage.setItem('desktopHorizontalScroll', String(horizontalScroll)); } catch (_) {}
          render();
        });
        scrollLabel.append(scrollToggle, doc.createTextNode('横向滚动'));
        scrollLabel.title = '关闭后：单行自动缩字；多行模式长句自动换行';
        settings.append(scrollLabel);
        const settingsButton = doc.createElement('button');
        settingsButton.type = 'button'; settingsButton.textContent = '⚙';
        settingsButton.title = '字幕设置'; settingsButton.setAttribute('aria-label', '字幕设置');
        settingsButton.setAttribute('aria-expanded', 'false');
        settingsButton.setAttribute('aria-controls', 'desktopSettings');
        settingsButton.addEventListener('click', () => {
          settings.hidden = !settings.hidden;
          settingsButton.setAttribute('aria-expanded', String(!settings.hidden));
          fitRows();
        });
        doc.querySelector('nav').append(settingsButton);
        const alignLabel = doc.createElement('label'); alignLabel.textContent = '对齐';
        const alignSelect = doc.createElement('select'); alignSelect.setAttribute('aria-label', '字幕对齐');
        for (const [value, label] of [['left', '居左'], ['center', '居中'], ['right', '居右']]) {
          const option = doc.createElement('option'); option.value = value; option.textContent = label; alignSelect.append(option);
        }
        alignSelect.value = alignment;
        alignSelect.addEventListener('change', () => {
          alignment = alignSelect.value;
          try { localStorage.setItem('desktopAlignment', alignment); } catch (_) {}
          render();
        });
        alignLabel.append(alignSelect); settings.append(alignLabel);
        for (const [key, label, initial] of [['Background', '背景颜色', background], ['Foreground', '字体颜色', foreground]]) {
          const wrapper = doc.createElement('label'); wrapper.textContent = label;
          const picker = doc.createElement('input'); picker.type = 'color'; picker.value = initial;
          picker.setAttribute('aria-label', label);
          picker.addEventListener('input', () => {
            if (key === 'Background') background = picker.value; else foreground = picker.value;
            try { localStorage.setItem('desktop' + key, picker.value); } catch (_) {}
            render();
          });
          wrapper.append(picker); settings.append(wrapper);
        }
        const reset = doc.createElement('button'); reset.textContent = '↺'; reset.title = '恢复默认配色'; reset.setAttribute('aria-label', reset.title);
        reset.addEventListener('click', () => {
          background = '#172033'; foreground = '#f8fafc';
          settings.querySelector('[aria-label="背景颜色"]').value = background;
          settings.querySelector('[aria-label="字体颜色"]').value = foreground;
          try { localStorage.setItem('desktopBackground', background); localStorage.setItem('desktopForeground', foreground); } catch (_) {}
          render();
        });
        settings.append(reset);
        const hideToolbar = doc.createElement('button');
        hideToolbar.type = 'button'; hideToolbar.textContent = '⌃';
        hideToolbar.title = '隐藏标题和操作栏'; hideToolbar.setAttribute('aria-label', hideToolbar.title);
        doc.querySelector('nav').append(hideToolbar);
        const restoreToolbar = doc.createElement('button');
        restoreToolbar.type = 'button'; restoreToolbar.id = 'restoreToolbar'; restoreToolbar.textContent = '⌄';
        restoreToolbar.title = '显示标题和操作栏'; restoreToolbar.setAttribute('aria-label', restoreToolbar.title);
        doc.body.append(restoreToolbar);
        function applyToolbarVisibility() {
          doc.querySelector('header').hidden = toolbarHidden;
          if (toolbarHidden) {
            settings.hidden = true;
            settingsButton.setAttribute('aria-expanded', 'false');
          }
          restoreToolbar.hidden = !toolbarHidden;
          fitRows();
        }
        function setToolbarHidden(value) {
          toolbarHidden = value;
          try { localStorage.setItem('desktopToolbarHidden', String(value)); } catch (_) {}
          applyToolbarVisibility();
        }
        hideToolbar.addEventListener('click', () => setToolbarHidden(true));
        restoreToolbar.addEventListener('click', () => setToolbarHidden(false));
        applyToolbarVisibility();
        button.textContent = '关闭桌面字幕';
        button.setAttribute('aria-pressed', 'true');
        pip.addEventListener('pagehide', () => {
          if (frame) pip.cancelAnimationFrame(frame);
          frame = 0;
          pip = null;
          elements = null;
          button.textContent = '桌面字幕';
          button.setAttribute('aria-pressed', 'false');
        }, { once: true });
        render();
        frame = pip.requestAnimationFrame(animate);
      } catch (error) {
        if (pip && !pip.closed) pip.close();
        pip = null;
        elements = null;
        onError('无法打开桌面字幕，请允许浏览器画中画功能，然后再次点击按钮。');
      } finally {
        opening = false;
        button.disabled = false;
      }
    }
    button.addEventListener('click', toggle);
    return { render };
  };
})();
