// SPDX-License-Identifier: GPL-3.0-or-later
// First-start tour: a few coach marks over the real editor (a ring on the part, a card beside it), shown once on an empty
// library and again from the shortcut sheet (?). Keys: Enter / → next, ← back, Esc closes. Page only (after app.js).
'use strict';
const TOUR = [
  { t: 'Welcome to Cutroom', d: 'A video editor that runs on this Mac. Your footage, the AI tools and every export stay here: no account, no upload.' },
  { el: '.imports', t: 'Bring in your footage', d: 'Import media, or drop files anywhere in the window. Hover a video to skim it; click it to mark a range with I and O.' },
  { el: '.rail', t: 'Everything to add', d: 'Sound, text, stickers, effects, transitions, filters, captions, the script view and the on-device AI tools.' },
  { el: '#stage', t: 'Preview is the export', d: 'What plays here is exactly what the file gets. G opens scopes, F the big preview.' },
  { el: '.timeline', t: 'The timeline', d: 'The main track is magnetic: clips play back to back. Space plays, S splits at the playhead, ⌘Z undoes anything.' },
  { el: '#inspector', t: 'Clip settings', d: 'Select a clip and its speed, colour, sound, masks and keyframes appear here.' },
  { el: '#btnAsk', t: 'Ask for an edit', d: '⌘K: say what you want ("cut the pauses, add captions"); the local model plans it and you watch it happen. Each step is one undo.' },
  { el: '#btnExport', t: 'Export', d: 'MP4, HEVC, ProRes, GIF, HDR, transparent video, subtitles, and Final Cut / Resolve timelines. Press ? for every shortcut.' },
];
let tourAt = -1;

function tourShow(i) {
  tourAt = i;
  let box = $('#tour');
  if (!box) {
    box = document.createElement('div');
    box.id = 'tour';
    box.innerHTML = '<div class="tring"></div><div class="tcard" role="dialog" aria-modal="true" aria-labelledby="tourT"><p class="tstep"></p><h3 id="tourT"></h3><p class="td"></p>'
      + '<div class="actions"><button data-t="skip" class="ghost">Skip</button><button data-t="back">Back</button><button data-t="next" class="primary">Next</button></div></div>';
    box.addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) tourGo(b.dataset.t); });
    document.body.append(box);
    addEventListener('resize', tourPlace);
  }
  const s = TOUR[i];
  $('.tstep', box).textContent = `${i + 1} of ${TOUR.length}`;
  $('#tourT').textContent = s.t;
  $('.td', box).textContent = s.d;
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
function tourMaybe() { if (!store.get('cutroom.tour') && !M.size) tourShow(0); }
