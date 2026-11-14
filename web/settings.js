// SPDX-License-Identifier: GPL-3.0-or-later
// Settings (gear in the top bar, ⌘, or Ctrl+,): one window for the choices the editor otherwise remembers in many places.
// Each option is read where the editor already looks (opt() in app.js, PREFS, localStorage keys) and applies at once.
// Kept per computer in localStorage ('cutroom.settings', or the key the editor already used), or per library in the
// server's <library>/settings.json when the server has to know (version history, export folder, proxies, the local model).
// Page only, after app.js and tour.js.
'use strict';
const SET = (() => {
  const LKEY = 'cutroom.settings', secs = [['general', 'General'], ['editing', 'Editing'], ['playback', 'Playback and preview'], ['export', 'Export'],
    ['keys', 'Shortcuts'], ['ai', 'AI and this computer'], ['storage', 'Storage'], ['about', 'About']];
  const num = a => a.map(x => (Array.isArray(x) ? x : [x, String(x)]));
  const secsOf = a => a.map(x => [x, x === 1 ? '1 second' : `${x} seconds`]);
  // AI features: AI_BUDGET kind, name, what it hides (also the inspector's buttons, drawn later), the remote commands it refuses
  const AIF = [
    ['captions', 'Auto captions, edit by script', '[data-aitool="captions"], #btnCaptions, [data-tab="script"], #btnFillers, #btnScriptFill', ['auto_captions', 'transcript', 'main_transcript', 'remove_fillers']],
    ['voice', 'AI voiceover', '#btnAiVoice', ['ai_voiceover']],
    ['clone', 'Voice clone and dubbing', '#btnClone, #btnDub', ['clone_voice', 'dub_video']],
    ['music', 'AI music', '#btnMusic', ['generate_music']],
    ['image', 'Image and sticker generation', '#btnAiImage, #btnStickerAI', ['ai_image']],
    ['remove', 'Remove object', '[data-aitool="removeobj"], [data-act="removeobj"]', ['remove_object']],
    ['cutout', 'Cut out object', '[data-aitool="cutobj"], [data-act="cutobj"]', ['cut_out_object', 'preview_object']],
    ['matte', 'Remove background', '[data-aitool="matte"], [data-act="matte"]', ['clip_tool:remove_background']],
    ['isolate', 'Isolate voice, stems', '[data-aitool="isovoice"], [data-aitool="novoice"], [data-act="isovoice"], [data-act="novoice"], [data-act="stems"]', ['clip_tool:isolate_voice', 'clip_tool:remove_voice', 'clip_tool:split_stems']],
    ['upscale', 'AI upscale', '[data-act="upscale"]', ['clip_tool:ai_upscale']],
    ['relight', 'Relight', '[data-act="relight"]', ['clip_tool:relight']],
    ['llm', 'Local language model: shorts, hooks, translation, caption keywords and emoji, Ask', '#btnShorts, #btnHooks, #btnTranslate, #btnAsk, #btnCombine, #btnIndex, label:has(#capKw), label:has(#capEmoji), label:has(#trBi)',
      ['make_shorts', 'hook_titles', 'translate_captions', 'pilot', 'smart_combine', 'search_media:?index', 'caption_extras:?keywords|emoji|bilingual']],
  ];
  // k key, s section, l label, c control (check / select / text / checks / folder), d default, o options, h help;
  // where: pref = PREFS (the setup answers), lib = this library, st = an older localStorage key, else this computer's LKEY
  const OPTS = [
    { k: 'ratio', s: 'general', l: 'New project shape', c: 'select', d: '9:16', pref: 1, o: () => Object.keys(RATIOS).map(r => [r, `${r} · ${RATIO_NAMES[r]}`]) },
    { k: 'fps', s: 'general', l: 'New project frame rate', c: 'select', d: 30, pref: 1, o: () => num([24, 25, 30, 50, 60]).map(([v, n]) => [v, `${n} fps`]) },
    { k: 'newName', s: 'general', l: 'New project name', c: 'text', d: 'Untitled {date}', h: '{date} and {time} are filled in' },
    { k: 'openLast', s: 'general', l: 'Open the last project on start', c: 'check', d: true, h: 'Off: the projects list opens first' },
    { k: 'versionsGap', s: 'general', l: 'Autosave keeps a version every', c: 'select', d: 5, lib: 1, o: () => [[1, '1 minute'], [2, '2 minutes'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes']], h: 'Every edit is saved at once, always; this is how often a restorable version is kept while you edit' },
    { k: 'versionsKeep', s: 'general', l: 'Versions kept per project', c: 'select', d: 60, lib: 1, o: () => num([20, 60, 120, 250]), h: 'The newest; versions you name are kept until you delete them' },
    { s: 'general', l: 'First start', c: 'buttons', b: [['setup', 'Ask the setup questions again'], ['tour', 'Take the tour again']] },

    { k: 'snap', s: 'editing', l: 'Snapping', c: 'check', d: true, h: 'Dragged clips snap to the playhead, clip edges, markers and beats' },
    { k: 'snapPx', s: 'editing', l: 'Snapping strength', c: 'select', d: 8, o: () => [[4, 'Light (4 px)'], [8, 'Normal (8 px)'], [16, 'Strong (16 px)']] },
    { k: 'ripple', s: 'editing', l: 'Ripple all tracks in new projects', c: 'check', d: false, h: 'Cutting or trimming the main track moves every track after it, linked or not' },
    { k: 'imgDur', s: 'editing', l: 'Photo length', c: 'select', d: 3, o: () => secsOf([1, 2, 3, 4, 5, 8, 10]) },
    { k: 'textDur', s: 'editing', l: 'Text length', c: 'select', d: 3, o: () => secsOf([1, 2, 3, 4, 5, 8, 10]) },
    { k: 'trType', s: 'editing', l: 'Transition on each new cut', c: 'select', d: 'none', o: () => TRANSITIONS, h: 'Added when a clip joins the main track' },
    { k: 'trDur', s: 'editing', l: 'Transition length', c: 'select', d: 0.5, o: () => [0.25, 0.5, 0.75, 1, 1.5, 2].map(x => [x, `${x} s`]) },
    { k: 'textPreset', s: 'editing', l: 'Add text uses', c: 'select', d: 'Subtitle', o: () => Object.keys(TEXT_PRESETS).map(x => [x, x]) },
    { k: 'capStyle', s: 'editing', l: 'Caption style in new projects', c: 'select', d: 'Bold', o: () => Object.keys(CAP_PRESETS).map(x => [x, x]) },
    { k: 'lang', s: 'editing', l: 'Caption language', c: 'select', d: 'auto', pref: 1, o: () => $$('#capLang option').map(x => [x.value, x.textContent]) },
    { k: 'capWords', s: 'editing', l: 'Words per caption', c: 'select', d: 3, o: () => num([1, 2, 3, 4, 6]) },
    { k: 'scrub', s: 'editing', l: 'Sound while scrubbing', c: 'check', d: true, st: 'cutroom.scrubSound', h: '⇧A turns it on and off too' },
    { k: 'thumbs', s: 'editing', l: 'Timeline thumbnails', c: 'check', d: true, h: 'Off: clips are drawn as colour and sound only, lighter on long timelines' },

    { k: 'pq', s: 'playback', l: 'Preview quality', c: 'select', d: 'auto', st: 'cutroom.pq', o: () => [['auto', 'Auto: half while playing if frames are missed'], ['full', 'Full'], ['half', 'Half'], ['quarter', 'Quarter']], h: 'The picture here only: exports are always full' },
    { k: 'proxy', s: 'playback', l: 'Preview copies (proxies)', c: 'select', d: 'auto', lib: 1, o: () => [['auto', 'Auto: 4K, HDR, ProRes and long-GOP files'], ['always', 'Always, for every video'], ['never', 'Never for 4K and other heavy SDR files']], h: 'For new imports, and for the library after Clear preview cache (Storage). HDR, ProRes, MKV and 4:2:2 always get one: the preview cannot show them otherwise. Exports always read the originals.' },
    { k: 'loop', s: 'playback', l: 'Loop playback', c: 'check', d: false, h: 'Playing to the end starts again from the beginning' },
    { k: 'scopesStart', s: 'playback', l: 'Scopes on start', c: 'select', d: 'last', o: () => [['last', 'As I left them'], ['on', 'Shown'], ['off', 'Hidden']] },
    { k: 'meterStart', s: 'playback', l: 'Loudness meter on start', c: 'select', d: 'last', o: () => [['last', 'As I left it'], ['on', 'Shown'], ['off', 'Hidden']] },
    { k: 'motion', s: 'playback', l: 'Interface motion', c: 'select', d: 'system', o: () => [['system', 'Follow the system'], ['reduce', 'Reduce'], ['full', 'Full']], h: 'Panel and button transitions; playback is never affected' },

    { k: 'preset', s: 'export', l: 'Preset', c: 'select', d: '', pref: 1, o: () => [['', 'None'], ...Object.entries(EX_PRESETS).map(([k, x]) => [k, x.name])] },
    { k: 'also', s: 'export', l: 'Also export as', c: 'checks', d: [], pref: 1, o: () => SHAPES.map(r => [r, r]), h: 'Each ticked shape is a copy of the edit laid out for it (shapes other than the project\'s own)' },
    { k: 'exportDir', s: 'export', l: 'Folder', c: 'folder', d: '', lib: 1 },
    { k: 'exName', s: 'export', l: 'File name', c: 'text', d: '{project}', h: '{project}, {date} and {time} are filled in' },
    { k: 'light', s: 'export', l: 'Light export (less CPU)', c: 'check', d: false, h: 'Decodes on the media engine: the processor stays free, the export can take longer' },
    { k: 'loud', s: 'export', l: 'Loudness a preset aims at', c: 'select', d: -14, o: () => [[-14, '−14 LUFS · social'], [-16, '−16 LUFS · podcast'], [-23, '−23 LUFS · broadcast (EBU)']] },
    { k: 'openDone', s: 'export', l: 'Open the file when it is done', c: 'check', d: false },
    { k: 'notify', s: 'export', l: 'When an export finishes', c: 'select', d: 'none', o: () => [['none', 'Only the Exports panel'], ['sound', 'Play a sound'], ['note', 'Show a notification'], ['both', 'Sound and notification']] },

    ...AIF.map(([kind, name]) => ({ k: `ai.${kind}`, s: 'ai', l: name, c: 'check', d: true, kind, lib: 1 })), // with the library: the server refuses an off feature by every path
    { k: 'llm', s: 'ai', l: 'Local language model', c: 'llm', d: '', lib: 1 },
  ];
  const BY = Object.fromEntries(OPTS.filter(o => o.k).map(o => [o.k, o]));
  let LOC = {}, LIB = {}, INFO = {}, sec = 'general', q = '';
  try { LOC = JSON.parse(store.get(LKEY)) || {}; } catch { /* nothing kept */ }
  const fmtB = n => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
  const frag = s => document.createRange().createContextualFragment(s); // every value put in goes through esc()

  function get(k) {
    const o = BY[k];
    if (!o) return undefined;
    let v;
    if (o.lib) v = LIB[k];
    else if (o.pref) v = PREFS[k];
    else if (o.st) { const s = store.get(o.st); v = s == null ? undefined : k === 'scrub' ? s !== 'off' : s; }
    else v = LOC[k];
    return v ?? o.d;
  }
  async function set(k, v) { // v undefined = back to the default
    const o = BY[k];
    if (o.lib) { const r = await api('/api/settings', { [k]: v === undefined || v === o.d ? null : v }); LIB = r.lib; }
    else if (o.pref) { if (v === undefined) delete PREFS[k]; else PREFS[k] = v; store.set('cutroom.prefs', JSON.stringify(PREFS)); }
    else if (o.st) store.set(o.st, k === 'scrub' ? (v === false ? 'off' : 'on') : v ?? o.d);
    else { if (v === undefined) delete LOC[k]; else LOC[k] = v; store.set(LKEY, JSON.stringify(LOC)); }
    apply(k);
  }
  function apply(k) { // what changes on screen at once (everything else is read when it's next used)
    const v = get(k);
    if (k === 'pq') setPQ(v);
    else if (k === 'lang' && $('#capLang')) $('#capLang').value = v;
    else if (k === 'capWords') $('#capWords').value = String(v);
    else if (k === 'trDur') { const r = $('#trDur'); r.value = String(v); r.dispatchEvent(new Event('input')); }
    else if (k === 'thumbs') drawStrips();
    else if (k === 'motion') { if (v === 'system') delete document.documentElement.dataset.motion; else document.documentElement.dataset.motion = v; }
    else if (k.startsWith('ai.')) aiStyle();
    else if (k === 'proxy') for (const el of pool.values()) el.dataset.media = ''; // the players load the media again (with or without its copy)
  }
  function aiStyle() { // a feature turned off: its buttons are gone (the inspector's too, whenever it's drawn)
    let st = $('#setAiOff');
    if (!st) { st = document.createElement('style'); st.id = 'setAiOff'; document.head.append(st); }
    const off = AIF.filter(([kind]) => !get(`ai.${kind}`)).map(f => f[2]);
    st.textContent = off.length ? `${off.join(', ')} { display: none !important; }` : '';
  }
  const GATE = {}; // remote command -> [feature, its name, the clip_tool action (or none: the whole command)]
  for (const [kind, name, , cmds] of AIF) for (const c of cmds) { const [cmd, action] = c.split(':'); (GATE[cmd] ||= []).push([kind, name, action]); }
  const missing = Object.keys(GATE).filter(cmd => !REMOTE[cmd]); // a renamed command would slip past its switch: said loudly, and tests/settings.mjs fails on it
  if (missing.length) console.error(`Settings: AI switches name commands the editor doesn't have: ${missing.join(', ')}`);
  for (const [cmd, gates] of Object.entries(GATE)) { // the MCP (and the command bar's plans) refuse a feature that's off
    const fn = REMOTE[cmd];
    if (fn) REMOTE[cmd] = async function (args = {}) {
      const hit = action => !action || (action[0] === '?' ? action.slice(1).split('|').some(k => args[k]) : action === args.action); // '?a|b': only when one of those arguments is given
      const g = gates.find(([kind, , action]) => hit(action) && !get(`ai.${kind}`));
      if (g) throw new Error(`${g[1]} is turned off in Settings (AI and this computer)`);
      return fn.call(this, args);
    };
  }

  // ---------- the window ----------
  const where = o => (o.lib ? '<span class="where" title="Kept in this library\'s settings.json: it travels with the library">This library</span>' : '<span class="where" title="Kept on this computer (this browser\'s storage)">This computer</span>');
  function control(o) {
    const v = get(o.k), id = `set-${o.k.replace('.', '-')}`;
    if (o.c === 'check') return `<input id="${id}" type="checkbox" data-set="${o.k}"${v ? ' checked' : ''}>`;
    if (o.c === 'text') return `<input id="${id}" type="text" data-set="${o.k}" value="${esc(v)}" spellcheck="false">`;
    if (o.c === 'select') return `<select id="${id}" data-set="${o.k}">${o.o().map(([x, n]) => `<option value="${esc(x)}"${String(x) === String(v) ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
    if (o.c === 'checks') return `<div class="setchecks" id="${id}">${o.o().map(([x, n]) => `<label><input type="checkbox" data-set="${o.k}" value="${esc(x)}"${v.includes(x) ? ' checked' : ''}>${esc(n)}</label>`).join('')}</div>`;
    if (o.c === 'folder') return `<div class="setfolder"><input id="${id}" type="text" data-set="${o.k}" value="${esc(v || '')}" placeholder="${esc(INFO.libExports || 'The library\'s exports folder')}" spellcheck="false" aria-label="Export folder">`
      + `${INFO.pickFolder ? '<button data-setdo="pick">Choose…</button>' : ''}<button data-setdo="libfolder"${v ? '' : ' disabled'}>Library's folder</button></div>`;
    if (o.c === 'llm') return `<select id="${id}" data-set="llm" disabled><option>Looking…</option></select>`;
    return '';
  }
  function row(o) {
    if (o.c === 'buttons') return `<div class="setrow" data-find="${esc(`${o.l} ${o.b.map(b => b[1]).join(' ')}`)}"><div class="setl"><b>${esc(o.l)}</b></div><div class="setc">${o.b.map(([a, n]) => `<button data-setdo="${a}">${esc(n)}</button>`).join('')}</div></div>`;
    const cap = o.kind ? '<small class="setcap" data-capfor="' + o.kind + '"></small>' : '';
    return `<div class="setrow${o.c === 'checks' ? ' tall' : o.c === 'folder' ? ' wide' : ''}" data-find="${esc(`${o.l} ${o.h || ''}`)}" data-key="${o.k}"><label class="setl" for="set-${o.k.replace('.', '-')}"><b>${esc(o.l)}</b>${o.h ? `<small>${esc(o.h)}</small>` : ''}${cap}</label><div class="setc">${control(o)}${where(o)}</div></div>`;
  }
  const custom = {
    keys: () => '<div id="setKeys"></div>',
    ai: () => '<p id="setMacSum" class="hint">Reading what this computer runs…</p>' + OPTS.filter(o => o.s === 'ai').map(row).join('')
      + `<div class="setrow" data-find="remote gpu offload another computer"><div class="setl"><b>Another computer's GPU</b><small>${INFO.gpuHost ? 'Set by CUTROOM_GPU_HOST; lip sync, talking photo and AI video run there.' : 'Off. Set CUTROOM_GPU_HOST to use another computer for lip sync, talking photo and AI video.'}</small></div><div class="setc"><span class="where">Read only</span></div></div>`,
    storage: () => `<div class="setrow" data-find="library location folder"><div class="setl"><b>Library</b><small class="path">${esc(INFO.home || '')}</small></div><div class="setc"><button data-setdo="showlib">${INFO.pickFolder ? 'Show in Finder' : 'Show the folder'}</button></div></div>`
      + '<div class="setrow" data-find="cache preview proxies thumbnails waveforms clear"><div class="setl"><b>Preview cache</b><small>Preview copies, filmstrips, waveforms and photo thumbnails: made again from your media when cleared. Media, projects and transcripts stay.</small><small id="setCache" class="setnum">…</small></div><div class="setc"><button data-setdo="clearcache">Clear preview cache</button></div></div>'
      + '<div class="setrow" data-find="trash deleted empty"><div class="setl"><b>Trash</b><small>Deleted projects, media, voices and LUTs, kept so they can be restored.</small><small id="setTrash" class="setnum">…</small></div><div class="setc"><button data-setdo="emptytrash">Empty trash…</button></div></div>',
    about: () => `<div class="setrow" data-find="version about"><div class="setl"><b>Cutroom ${esc(INFO.version || '')}</b><small>${INFO.commit ? `Build ${esc(INFO.commit)}` : ''}</small></div></div>`
      + '<div class="setrow" data-find="licence license gpl"><div class="setl"><b>Licence</b><small>GNU General Public License v3 or later: free to use, change and share; versions you distribute stay open under the same terms.</small></div></div>'
      + '<div class="setrow" data-find="third party licences models"><div class="setl"><b>Third-party software and models</b><small>What Cutroom uses, where it comes from and its licence.</small></div><div class="setc"><button data-setdo="third">Show the list</button></div></div><pre id="setThird" class="setthird" hidden></pre>'
      + `<div class="setrow" data-find="logs server log"><div class="setl"><b>Logs</b><small class="path">${esc(INFO.log || '')}</small></div><div class="setc"><button data-setdo="showlog">${INFO.pickFolder ? 'Show in Finder' : 'Show the folder'}</button></div></div>`,
  };
  function body() {
    return secs.map(([s, n]) => `<section class="setsec" data-sec="${s}"${s === sec || q ? '' : ' hidden'}><h3>${esc(n)}</h3>${custom[s] ? custom[s]() : OPTS.filter(o => o.s === s).map(row).join('')}</section>`).join('');
  }
  async function open(at) {
    if (at) sec = at;
    q = '';
    INFO = await api('/api/settings').catch(() => INFO);
    LIB = INFO.lib || LIB;
    modal(`<div class="sethead"><h2>Settings</h2><input id="setQ" type="search" placeholder="Search settings" aria-label="Search settings" spellcheck="false"></div>`
      + `<div class="setbody"><nav class="setnav" aria-label="Settings sections">${secs.map(([s, n]) => `<button data-setsec="${s}"${s === sec ? ' class="on" aria-current="true"' : ''}>${esc(n)}</button>`).join('')}</nav><div class="setmain">${body()}</div></div>`
      + '<div class="actions"><button data-setdo="resetsec">Reset this section</button><button data-setdo="resetall">Reset all</button><span class="spacer"></span><button data-close>Close</button></div>', 'settings');
    const dlg = $('#modal .dialog.settings');
    dlg.addEventListener('click', e => { click(e).catch(err => toast(err.message)); });
    dlg.addEventListener('change', e => { change(e.target).catch(err => { toast(err.message); redraw(); }); });
    $('#setQ').addEventListener('input', e => { q = e.target.value.trim().toLowerCase(); search(); });
    fill();
    $('#setQ').focus();
  }
  function search() {
    const main = $('.setmain');
    if (!q) { for (const s of $$('.setsec', main)) s.hidden = s.dataset.sec !== sec; for (const r of $$('.setrow, .keys tr', main)) r.hidden = false; return; }
    for (const s of $$('.setsec', main)) { // a section's name shows all of it; else the rows (and shortcuts) that say it
      const head = s.querySelector('h3').textContent.toLowerCase().includes(q), rows = $$('.setrow, .keys tr', s);
      for (const r of rows) r.hidden = !(head || (r.dataset.find || r.textContent).toLowerCase().includes(q));
      s.hidden = !rows.some(r => !r.hidden);
    }
  }
  function redraw() { const m = $('.setmain'); if (!m) return; const top = m.scrollTop; m.replaceChildren(frag(body())); fill(); search(); m.scrollTop = top; }
  async function fill() { // the parts that come from the server or other code
    shortcuts(false);
    api('/api/settings/storage').then(s => { if ($('#setCache')) { $('#setCache').textContent = `${fmtB(s.cache)} of ${fmtB(s.cacheAll)} in the cache folder`; $('#setTrash').textContent = fmtB(s.trash); } }).catch(() => {});
    api('/api/ai/caps').then(c => {
      if (!$('#setMacSum')) return;
      $('#setMacSum').textContent = `${c.ram} GB memory · ${c.cores} CPU cores · ${c.gpu} GPU cores. ${c.queue[0].toUpperCase()}${c.queue.slice(1)}. A feature turned off here loses its buttons, and the MCP refuses it.`;
      for (const el of $$('[data-capfor]')) {
        const j = c.jobs.find(x => x.kind === el.dataset.capfor);
        el.textContent = !j ? '' : j.refused ? `Not on this computer: ${j.refused.replace(/^.*? needs/, 'needs')}` : `Runs here as ${j.size}${j.smaller ? ' (smaller on this computer)' : ''}`;
        el.classList.toggle('off', !!j?.refused);
      }
    }).catch(() => {});
    api('/api/settings/llm').then(r => {
      const s = $('#set-llm');
      if (!s) return;
      const pick = LIB.llm || '';
      s.replaceChildren(frag((r.models.length ? `<option value="">Automatic: the biggest that fits${r.pick ? ` (${esc(r.pick)})` : ''}</option>` : `<option value="">${esc(r.why || 'No model installed (ollama pull qwen3.5:9b)')}</option>`)
        + r.models.map(m => `<option value="${esc(m)}"${m === pick ? ' selected' : ''}>${esc(m)}</option>`).join('')));
      s.disabled = r.models.length < 2;
      s.title = r.models.length < 2 ? 'A choice appears when several installed models fit this computer' : '';
    }).catch(() => {});
  }
  async function change(el) {
    const k = el.dataset.set, o = BY[k];
    if (!o) return;
    let v;
    if (o.c === 'check') v = el.checked;
    else if (o.c === 'checks') v = $$(`[data-set="${k}"]:checked`).map(x => x.value);
    else if (o.c === 'select' || o.c === 'llm') v = typeof o.d === 'number' ? +el.value : el.value;
    else v = el.value.trim();
    await set(k, v === '' && o.c === 'text' ? undefined : v);
    if (o.lib) redraw();
    toast(`${o.l}: saved for ${o.lib ? 'this library' : 'this computer'}`);
  }
  async function reset(keys) {
    for (const k of keys) if (BY[k]) await set(k, undefined);
    if (keys.includes('keys')) { KEYOWN = {}; applyKeys(true); }
    redraw();
  }
  async function click(e) {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.setsec) { sec = d.setsec; q = ''; $('#setQ').value = ''; KC.for = null; for (const x of $$('[data-setsec]')) { x.classList.toggle('on', x === b); x.toggleAttribute('aria-current', x === b); } search(); $('.setmain').scrollTop = 0; return; }
    const a = d.setdo;
    if (!a) return;
    if (a === 'resetsec') return reset([...OPTS.filter(o => o.s === sec && o.k).map(o => o.k), ...(sec === 'keys' ? ['keys'] : [])]).then(() => toast('This section is back to its defaults'));
    if (a === 'resetall') return reset([...Object.keys(BY), 'keys']).then(() => toast('Every setting is back to its default'));
    if (a === 'setup') { closeModal(); setupAns = {}; setupShow(0); }
    else if (a === 'tour') { closeModal(); tourShow(0); }
    else if (a === 'pick') { const r = await api('/api/settings/pick-folder', {}); if (r.path) { await set('exportDir', r.path); redraw(); } }
    else if (a === 'libfolder') { await set('exportDir', undefined); redraw(); }
    else if (a === 'showlib' || a === 'showlog') await api('/api/settings/reveal', { what: a === 'showlog' ? 'log' : 'library' });
    else if (a === 'clearcache') {
      b.disabled = true;
      const r = await api('/api/settings/clear-cache', {});
      gridImgs.clear(); peakData.clear(); // the timeline asks for the new ones as they are made
      toast(`Cleared ${fmtB(r.bytes)} (${r.removed} files); ${r.rebuilding} library items are being prepared again`);
      await loadMedia(); fill(); b.disabled = false;
    } else if (a === 'emptytrash') {
      if (!confirm('Empty the trash? Deleted projects, media, voices and LUTs in it are gone for good, and clips that still use trashed media cannot be restored.')) return;
      const r = await api('/api/settings/empty-trash', {});
      toast(`Trash emptied: ${fmtB(r.bytes)} freed`); fill();
    } else if (a === 'third') {
      const p = $('#setThird');
      if (p.hidden && !p.textContent) p.textContent = (await api('/api/settings/thirdparty')).text;
      p.hidden = !p.hidden; b.textContent = p.hidden ? 'Show the list' : 'Hide the list';
    }
  }

  // ---------- what other code asks ----------
  function exportOpened() { // the Export dialog: the name pattern, Light, and where the file goes
    const n = $('#exName');
    if (n) n.value = fillName(get('exName'), { project: P.name }) || P.name;
    if ($('#exLight')) $('#exLight').checked = !!get('light');
    const dir = (LIB.exportDir || INFO.libExports || '').replace(/^\/Users\/[^/]+/, '~') || 'the library\'s exports folder';
    $('#exAlso')?.insertAdjacentElement('afterend', frag(`<div class="row" id="exDir"><span>Folder</span><div class="exdir"><small class="path" title="${esc(dir)}">${esc(dir)}</small><button class="ghost" data-setopen="export">Change…</button></div></div>`).firstElementChild);
    $('#exDir button').addEventListener('click', () => open('export'));
  }
  function exported(j) { // an export finished (any row of the Exports panel)
    if (get('openDone') && j.file) api('/api/reveal', { file: j.file, play: true }).catch(() => {});
    const how = get('notify');
    if (how === 'sound' || how === 'both') { // two soft tones, about a third of a second
      try {
        const A = new AudioContext(), t = A.currentTime;
        for (const [f, at] of [[660, 0], [880, 0.14]]) { const o = A.createOscillator(), g = A.createGain(); o.frequency.value = f; g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(0.2, t + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.18); o.connect(g).connect(A.destination); o.start(t + at); o.stop(t + at + 0.2); }
        setTimeout(() => A.close(), 600);
      } catch { /* no sound device */ }
    }
    if ((how === 'note' || how === 'both') && typeof Notification === 'function' && Notification.permission === 'granted') new Notification('Export finished', { body: j.file || '' });
    else if (how === 'note' || how === 'both') toast(`Export finished: ${j.file || ''}`);
  }

  REMOTE.settings = async ({ set: s } = {}) => { // the MCP: every option, its value and where it is kept; set = {key: value} (null = the default)
    for (const [k, v] of Object.entries(s || {})) {
      const o = BY[k], opts = o?.o ? o.o().map(x => x[0]) : null;
      if (!o) throw new Error(`no setting ${k} (one of ${Object.keys(BY).join(', ')})`);
      const ok = v === null || (o.c === 'check' ? typeof v === 'boolean' : o.c === 'select' ? opts.some(x => String(x) === String(v))
        : o.c === 'checks' ? Array.isArray(v) && v.every(x => opts.includes(x)) : typeof v === 'string');
      if (!ok) throw new Error(`${k}: ${o.c === 'check' ? 'true or false' : opts ? `${o.c === 'checks' ? 'a list of ' : 'one of '}${opts.join(', ')}` : 'text'}`);
      await set(k, v === null ? undefined : o.c === 'select' && typeof o.d === 'number' ? +v : v);
    }
    if ($('#modal .dialog.settings')) redraw();
    return Object.fromEntries(OPTS.filter(o => o.k).map(o => [o.k, { value: get(o.k), label: o.l, section: o.s, kept: o.lib ? 'this library' : 'this computer', ...(o.c === 'select' ? { options: o.o().map(x => x[0]) } : {}) }]));
  };

  // ---------- on start (after app.js wired the editor, before the project opens) ----------
  for (const k of ['motion', 'capWords', 'trDur']) if (get(k) !== BY[k].d) apply(k);
  aiStyle();
  if (get('scopesStart') !== 'last') setScope({ on: get('scopesStart') === 'on' }, false);
  if (get('meterStart') !== 'last' && (get('meterStart') === 'on') !== MTR.on) meterSet(get('meterStart') === 'on');
  api('/api/settings').then(r => { INFO = r; LIB = r.lib || {}; aiStyle(); }).catch(() => {}); // (the AI switches are library settings: hide their buttons once known)
  $('#btnSettings').addEventListener('click', () => open());
  addEventListener('keydown', e => { // ⌘, (Ctrl+, off the Mac): ahead of the editor's keys, like ⌘K
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ',') { e.preventDefault(); e.stopPropagation(); if (!$('#modal .dialog.settings')) { if (!$('#modal').hidden) closeModal(); open(); } }
  }, true);
  const nprev = get('notify');
  if ((nprev === 'note' || nprev === 'both') && typeof Notification === 'function' && Notification.permission === 'default') addEventListener('pointerdown', () => Notification.requestPermission().catch(() => {}), { once: true });
  return { get, set, open, exportOpened, exported, OPTS, AIF, missing, lib: () => LIB };
})();
