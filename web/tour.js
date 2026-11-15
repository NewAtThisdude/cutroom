// SPDX-License-Identifier: GPL-3.0-or-later
// First-start tour: a few coach marks over the real editor (a ring on the part, a card beside it), shown once on an empty
// library and again from the shortcut sheet (?). Keys: Enter / → next, ← back, Esc closes. Page only (after app.js).
'use strict';
const TOUR_ALL = [
  { t: 'Welcome to Cutroom', d: 'A video editor that runs on this Mac. Your footage, the AI tools and every export stay here: no account, no upload.' },
  { el: '.imports', t: 'Bring in your footage', d: 'Import media, or drop files anywhere in the window. Hover a video to skim it; click it to mark a range with I and O.' },
  { el: '.rail', t: 'Everything to add', d: 'Sound, text, stickers, effects, transitions, filters, captions, the script view and the on-device AI tools.' },
  { el: '#stage', t: 'Preview is the export', d: 'What plays here is exactly what the file gets. G opens scopes, F the big preview.' },
  { el: '.timeline', t: 'The timeline', d: 'The main track is magnetic: clips play back to back. Space plays, S splits at the playhead, ⌘Z undoes anything.' },
  { el: '#inspector', t: 'Clip settings', d: 'Select a clip and its speed, colour, sound, masks and keyframes appear here.' },
  { el: '#btnAsk', t: 'Ask for an edit', d: '⌘K: say what you want ("cut the pauses, add captions"); the local model plans it and you watch it happen. Each step is one undo.' },
  { el: '#btnExport', t: 'Export', d: 'MP4, HEVC, ProRes, GIF, HDR, transparent video, subtitles, and Final Cut / Resolve timelines. Press ? for every shortcut.' },
  { t: 'Please enjoy Cutroom', d: 'It is free and open source, made for people who edit. If you like it, star the GitHub repo so more people can find it.', link: ['https://github.com/NewAtThisdude/cutroom', 'Star Cutroom on GitHub'] },
];
let TOUR = TOUR_ALL, tourAt = -1;

function tourShow(i) {
  if (!i) TOUR = TOUR_ALL.filter(s => !s.el || $(s.el)?.offsetParent != null); // no step for a part this computer hides (Ask, without the local model)
  tourAt = i;
  let box = $('#tour');
  if (!box) {
    box = document.createElement('div');
    box.id = 'tour';
    box.innerHTML = '<div class="tring"></div><div class="tcard" role="dialog" aria-modal="true" aria-labelledby="tourT"><p class="tstep"></p><h3 id="tourT"></h3><p class="td"></p><p class="tlink"><a target="_blank" rel="noopener"></a></p>'
      + '<div class="actions"><button data-t="skip" class="ghost">Skip</button><button data-t="back">Back</button><button data-t="next" class="primary">Next</button></div></div>';
    box.addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) tourGo(b.dataset.t); });
    document.body.append(box);
    addEventListener('resize', tourPlace);
  }
  const s = TOUR[i];
  $('.tstep', box).textContent = `${i + 1} of ${TOUR.length}`;
  $('#tourT').textContent = s.t;
  $('.td', box).textContent = s.d;
  const a = $('.tlink a', box); a.parentNode.hidden = !s.link; if (s.link) { a.href = s.link[0]; a.textContent = s.link[1]; } // (the app opens it in the browser)
  $('[data-t="back"]', box).hidden = !i;
  $('[data-t="next"]', box).textContent = i === TOUR.length - 1 ? 'Start editing' : i ? 'Next' : 'Show me around';
  tourPlace();
  $('[data-t="next"]', box).focus();
}

function tourPlace() { // the ring on the step's part (none: the card in the middle), the card beside it, inside the window
  const box = $('#tour');
  if (!box || tourAt < 0) return;
  const el = TOUR[tourAt].el && $(TOUR[tourAt].el), ring = $('.tring', box), card = $('.tcard', box);
  const r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null;
  ring.hidden = !r;
  box.classList.toggle('solo', !r);
  if (!r) { card.style.left = card.style.top = ''; return; }
  Object.assign(ring.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
  const W = innerWidth, H = innerHeight, cw = card.offsetWidth, ch = card.offsetHeight, g = 16;
  // right of it, else left, else below, else above; then held inside the window
  let x = r.right + g, y = r.top;
  if (x + cw > W - g) x = r.left - g - cw;
  if (x < g) { x = Math.min(Math.max(g, r.left), W - cw - g); y = r.bottom + g; if (y + ch > H - g) y = r.top - g - ch; }
  card.style.left = `${Math.round(Math.max(g, Math.min(x, W - cw - g)))}px`;
  card.style.top = `${Math.round(Math.max(g, Math.min(y, H - ch - g)))}px`;
}

function tourGo(a) {
  if (a === 'next' && tourAt < TOUR.length - 1) return tourShow(tourAt + 1);
  if (a === 'back' && tourAt > 0) return tourShow(tourAt - 1);
  if (a === 'back') return;
  $('#tour')?.remove();
  removeEventListener('resize', tourPlace);
  tourAt = -1;
  store.set('cutroom.tour', a === 'skip' ? 'skipped' : 'done');
}

addEventListener('keydown', e => { // ahead of the editor's own keys while the tour is open
  if (tourAt < 0) return;
  const a = { Enter: 'next', ArrowRight: 'next', ArrowLeft: 'back', Escape: 'skip' }[e.key];
  if (a && !(e.key === 'Enter' && e.target.closest?.('[data-t]'))) { e.preventDefault(); e.stopImmediatePropagation(); tourGo(a); }
  else if (!a && e.key !== 'Tab') e.stopImmediatePropagation(); // Space, S, Delete... stay with the tour
}, true);

// app.js boot(): a first start is an empty library on a Mac that hasn't seen the tour
function tourMaybe() {
  if ($('#capLang') && PREFS.lang) $('#capLang').value = PREFS.lang;
  if (!store.get('cutroom.setup') && !M.size) { setupAns = {}; setupShow(0); } else if (!store.get('cutroom.tour') && !M.size) tourShow(0);
}

// ---------- first-start setup: three questions that set the defaults (new project shape and frame rate, export preset,
// extra export shapes, caption language), kept per computer in localStorage 'cutroom.prefs'; replayable from the ? sheet
const SETUP = [
  { key: 'kind', q: 'What do you make most?', opts: [['short', 'Short vertical videos', 'TikTok, Reels, Shorts · 9:16'], ['youtube', 'YouTube videos', 'Wide · 16:9'],
    ['both', 'Both', 'Vertical, and a wide copy with each export'], ['square', 'Square posts', 'Feeds · 1:1']] },
  { key: 'fps', q: 'How should motion look?', opts: [[30, 'Standard', '30 frames a second, most videos'], [60, 'Extra smooth', '60 frames a second, sports and gaming'], [24, 'Cinematic', '24 frames a second, the film look']] },
  { key: 'lang', q: 'Captions, when you add them', opts: [['auto', 'In the language I speak', 'Detected from the sound'], ['en', 'English', 'Always English'], ['off', 'I rarely use captions', 'Language detected when you do']] },
];
const KIND = { short: { ratio: '9:16', preset: 'tiktok', also: [] }, youtube: { ratio: '16:9', preset: 'yt1080', also: [] }, both: { ratio: '9:16', preset: 'shorts', also: ['16:9'] }, square: { ratio: '1:1', preset: 'reels', also: [] } };
let setupAns = {};

function setupShow(i) {
  tourAt = -1;
  let box = $('#tour');
  if (!box) {
    box = document.createElement('div');
    box.id = 'tour';
    document.body.append(box);
  }
  box.className = 'solo';
  const s = SETUP[i], first = i === 0;
  box.innerHTML = `<div class="tcard setup" role="dialog" aria-modal="true" aria-labelledby="setupQ"><p class="tstep">${first ? 'Welcome to Cutroom · ' : ''}Question ${i + 1} of ${SETUP.length}</p>`
    + `<h3 id="setupQ">${esc(s.q)}</h3>${first ? '<p class="td">Three quick answers set up new projects and exports for what you make. You can change any of it later.</p>' : ''}`
    + `<div class="sopts" role="radiogroup" aria-labelledby="setupQ">${s.opts.map(([v, n, d]) => `<button class="sopt" role="radio" aria-checked="false" data-s="${esc(String(v))}"><b>${esc(n)}</b><span>${esc(d)}</span></button>`).join('')}</div>`
    + `<div class="actions"><button data-x="skip" class="ghost">Skip, use the defaults</button>${i ? '<button data-x="back">Back</button>' : ''}</div></div>`;
  box.onclick = e => {
    const o = e.target.closest('[data-s]'), x = e.target.closest('[data-x]');
    if (o) { setupAns[s.key] = s.key === 'fps' ? +o.dataset.s : o.dataset.s; if (i + 1 < SETUP.length) setupShow(i + 1); else setupDone(true); }
    else if (x?.dataset.x === 'back') setupShow(i - 1);
    else if (x?.dataset.x === 'skip') setupDone(false);
  };
  box.onkeydown = e => { // arrows move between the answers, Enter / Space picks
    const all = $$('.sopt', box), at = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length].focus(); }
  };
  $('.sopt', box).focus();
}

function setupDone(answered) {
  const k = KIND[setupAns.kind] || KIND.short;
  if (answered) {
    Object.assign(PREFS, { kind: setupAns.kind, ratio: k.ratio, preset: k.preset, also: k.also, fps: setupAns.fps || 30, lang: setupAns.lang === 'en' ? 'en' : 'auto' });
    store.set('cutroom.prefs', JSON.stringify(PREFS));
  }
  store.set('cutroom.setup', answered ? 'done' : 'skipped');
  if (PREFS.lang && $('#capLang')) $('#capLang').value = PREFS.lang;
  if (answered && !P.main.length && !P.overlay.length && !P.audio.length && !P.text.length) { setProject(newProject()); scheduleSave(); } // the empty first project takes the answers
  const box = $('#tour');
  if (box) { box.onclick = null; box.onkeydown = null; box.parentNode.removeChild(box); }
  if (store.get('cutroom.tour') !== 'done') tourShow(1); // then the tour (its welcome was the setup's)
}
