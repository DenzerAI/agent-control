"""Deck router: Monitor-/Präsentations-Schicht (Klaus Deck / TV).

Extrahiert aus server.py als zweiter Schnitt der Modularisierung (nach
server.py). KEIN Verhalten geändert, nur verschoben. Routen-Pfade bleiben
byte-identisch, darum funktioniert das Host-/Token-Gate in server.py (das die
Deck-Pfade als String-Literale in seiner Allowlist führt) unverändert weiter.

Routen:
- GET  /deck                       — modul-freie Board-HTML für Smart-TVs
- GET  /tv                         — Pairing-/Koppel-Screen (token-frei)
- POST /api/deck/pane-input        — Transkript in Composer von Pane N pushen
- POST /api/deck/stop              — laufenden Agenten einer Session stoppen
- GET  /api/deck/logout            — Monitor sauber trennen (Cookie löschen)
- POST /api/deck/disconnect-all    — alle gekoppelten Bildschirme trennen
- GET  /api/deck/monitors          — Liste gekoppelter Bildschirme
- POST /api/deck/monitors/revoke   — einen Bildschirm gezielt trennen
- GET  /api/deck/me                — TV fragt eigenen Modus (chat|fokus)
- POST /api/deck/monitors/mode     — Modus eines Bildschirms umschalten
- POST /api/deck/scroll            — Remote-Scroll-Delta pushen
- GET  /api/deck/scroll            — akkumuliertes Scroll-Delta abholen
- POST /api/deck/speak             — Vorlese-Befehl (Handy -> TV)
- GET  /api/deck/speak             — Vorlese-Befehl abholen (TV)
- POST /api/deck/audio             — Audio-Status (TV -> Handy)
- GET  /api/deck/audio             — Audio-Status abholen (Handy)
- POST /api/deck/pair/new          — Pairing-Code anfordern (token-frei)
- GET  /api/deck/pair/qr           — SVG-QR für URL rendern (token-frei)
- GET  /api/deck/pair/poll         — Pairing-Status pollen (token-frei)
- POST /api/deck/pair/confirm      — Monitor vom Hauptgerät bestätigen

Bewusst in server.py VERBLIEBEN (von nicht-verschobenem Code genutzt):
- Das Host-/Token-Gate (@app.middleware) — führt die Deck-Pfade nur als
  String-Literale in seiner token-freien Allowlist; es liest KEINEN Deck-State.
- INDEX_NO_CACHE / MAX_SLOTS: triviale geteilte Konstanten, die auch andere
  (in server.py verbliebene) Routen nutzen. Hier gespiegelt statt importiert,
  analog zu den übrigen Key-Gettern.

State-Dicts (_deck_scroll/_deck_speak/_deck_audio/_deck_pairings) werden
AUSSCHLIESSLICH von Deck-Routen gelesen/geschrieben (per grep über die ganze
server.py verifiziert), darum wandern sie vollständig hierher mit.

EINZIGE Cross-Referenz: server.py behält die "/"-Route, die auf der
deck.*-Domain das ROHE _TV_HTML (ohne __REMOTE_ORIGIN__-Replace, byte-identisch
zum alten Verhalten) ausliefert. Sie holt _TV_HTML per Late-Import aus diesem
Modul. _TV_HTML lebt darum hier (beim /tv-Routen-Code), nicht in server.py.

Geteilte Helfer aus auth, die hier importiert werden:
- current_token, token_matches, mint_monitor_token, revoke_monitor_tokens,
  list_monitor_tokens, revoke_monitor_token, monitor_mode_for, set_monitor_mode.
- streaming.broadcast_pane_input / should_drop_duplicate_pane_input /
  request_stop: per Late-Import in der Funktion, gegen Zirkularität.
"""

import io
import os
import time
import secrets

from fastapi import APIRouter, Request, Body, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from auth import (
    current_token, token_matches,
    mint_monitor_token, revoke_monitor_tokens, list_monitor_tokens,
    revoke_monitor_token, monitor_mode_for, set_monitor_mode,
)

router = APIRouter()

# ── Geteilte Konstanten, in server.py gespiegelt (dort weiter von anderen,
#    nicht verschobenen Routen genutzt). Triviale Werte, darum dupliziert. ──
INDEX_NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate"}
MAX_SLOTS = 4


_DECK_BOARD_HTML = r"""<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Klaus Deck</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Lora:ital,wght@0,400;0,500;0,600;1,400&display=swap">
<style>
  /* Palette identisch zum Desktop (index.css, dark). */
  :root { --bg:#1F1F1E; --line:#2A2A29; --t1:#E6E6E3; --t2:#A1A1A0; --t3:#8a8278;
    --tbody:#CFCEC9; --strong:#E6E6E3; --link:#E07A4F; --accent:#d97757; --bubble:#141414;
    --mono:'SF Mono','Fira Code',ui-monospace,monospace;
    --body:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    --serif:'Lora',Georgia,'Times New Roman',serif; }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--t1);
    font-family:var(--body); -webkit-font-smoothing:antialiased; }
  #board { display:flex; flex-direction:row; height:100vh; gap:2px; padding:2px; }
  .pane { position:relative; flex:1 1 0; min-width:0; min-height:0; display:flex; flex-direction:column;
    background:var(--bg); border-radius:12px; border:1px solid var(--line); overflow:hidden; }
  .pane.active { border-color:var(--accent); box-shadow:0 0 0 2px rgba(217,119,87,0.25); }
  .head { flex:0 0 auto; padding:12px 18px; font-size:19px; font-weight:600; color:var(--t2);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; border-bottom:1px solid var(--line); }
  .pane.active .head { color:var(--accent); }
  .feed { flex:1 1 auto; overflow-y:auto; padding:16px 18px 20px; scrollbar-width:none; -ms-overflow-style:none; }
  .feed::-webkit-scrollbar { width:0; height:0; display:none; }
  .msg { margin-bottom:22px; display:flex; flex-direction:column; }
  .msg.me { align-items:flex-end; }
  .who { font-size:12px; font-weight:600; color:var(--t3); margin-bottom:4px; letter-spacing:.02em; }
  .msg.me .who { color:var(--accent); }
  /* Du: dunkle Bubble, Inter, rechts. */
  .bubble { max-width:90%; background:var(--bubble); border-radius:16px; padding:10px 15px; }
  .bubble .md { font-family:var(--body); font-size:19px; line-height:1.5; color:var(--tbody); }
  /* Klaus: keine Bubble, Lora, links — wie im Desktop. */
  .msg.klaus .agent { max-width:100%; }
  .agent .md { font-family:var(--serif); font-size:20px; line-height:1.55; color:var(--tbody); }
  /* Markdown-Elemente */
  .md p { margin:0 0 .7em; } .md p:last-child { margin-bottom:0; }
  .md strong { font-weight:700; color:var(--strong); }
  .md em { font-style:italic; color:var(--t1); }
  .md del { text-decoration:line-through; color:var(--t2); }
  .md a { color:var(--link); text-decoration:underline; text-underline-offset:2px; }
  .md code { font-family:var(--mono); font-size:.88em; }
  .md pre { font-family:var(--mono); font-size:14px; line-height:1.5; overflow-x:hidden;
    border-top:1px solid var(--line); border-bottom:1px solid var(--line); padding:12px 0; margin:.9em 0; }
  .md pre code { white-space:pre-wrap; word-break:break-word; font-size:14px; color:var(--t1); }
  .md ul { padding-left:1.4em; list-style:disc; margin:.6em 0; }
  .md ol { padding-left:1.4em; list-style:decimal; margin:.6em 0; }
  .md li { margin:.3em 0; }
  .md h1 { font-size:24px; font-weight:600; color:var(--t1); margin:1em 0 .5em; line-height:1.25; }
  .md h2 { font-size:21px; font-weight:600; color:var(--t1); margin:.9em 0 .45em; line-height:1.3; }
  .md h3 { font-size:19px; font-weight:600; color:var(--t1); margin:.8em 0 .4em; line-height:1.35; }
  .md blockquote { border-left:2px solid var(--accent); padding:2px 0 2px 14px; margin:.6em 0;
    color:var(--tbody); font-style:italic; }
  .md hr { border:0; border-top:1px solid var(--line); margin:1.1em 0; }
  /* Tool-Spur: schlank, mono, gedämpft — wie der Desktop-Work-Trace. */
  .tools { font-family:var(--mono); font-size:13px; color:var(--t3); margin-bottom:6px; line-height:1.3; }
  .tools .sec { color:var(--t2); }
  .empty { color:var(--t3); font-size:17px; margin-top:8px; font-family:var(--body); }
  /* Arbeits-/Queue-Status pro Pane, unten rechts — selber Pillen-Stil wie Desktop. */
  .pstat { position:absolute; right:14px; bottom:14px; display:flex; align-items:center; gap:9px; z-index:6; pointer-events:none; }
  .pstat .pill { display:none; align-items:center; gap:8px; font-family:var(--body); font-size:16px; font-weight:600;
    background:var(--bubble); border:1px solid var(--line); border-radius:999px; padding:7px 15px;
    box-shadow:0 3px 14px rgba(0,0,0,0.35); }
  /* Zeit schimmert wie auf dem Desktop (kein Punkt). Feste Breite: tabular-nums +
     min-width + zentriert, damit die Pille bei wechselnder Ziffernzahl nicht springt. */
  .pstat .busy .t { display:inline-block; min-width:44px; text-align:center; font-variant-numeric:tabular-nums;
    background:linear-gradient(90deg, rgba(230,230,227,0.55) 0%, rgba(230,230,227,0.55) 40%,
      rgba(255,255,255,0.95) 50%, rgba(230,230,227,0.55) 60%, rgba(230,230,227,0.55) 100%);
    background-size:300% 100%; -webkit-background-clip:text; background-clip:text;
    -webkit-text-fill-color:transparent; animation:deckshim 5s ease-in-out infinite; }
  .pstat .qn { color:var(--t2); }
  .pstat .qn .qb { display:inline-flex; align-items:center; justify-content:center; min-width:22px; height:22px;
    padding:0 6px; border-radius:999px; background:var(--accent); color:#fff; font-size:13px; font-weight:700;
    margin-right:7px; font-variant-numeric:tabular-nums; }
  @keyframes deckshim { 0%{background-position:100% 0} 100%{background-position:-100% 0} }
  #sndhint { position:fixed; left:50%; bottom:14px; transform:translateX(-50%);
    font-family:var(--body); font-size:14px; color:var(--t3); background:var(--bubble);
    border:1px solid var(--line); border-radius:999px; padding:7px 16px; opacity:.9; z-index:20; }
  @keyframes deckpulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  /* Lebenszeichen, dezent oben rechts. */
  #deckctl { position:fixed; top:12px; right:14px; display:flex; align-items:center; gap:12px; z-index:25; }
  #conndot { width:9px; height:9px; border-radius:50%; background:#5a8f6b; transition:background .3s; }
  #conndot.off { background:#c46b54; animation:deckpulse 1.2s ease-in-out infinite; }
  /* Reconnect-Schleier: erscheint wenn der Server/das WLAN weg ist, verschwindet von allein. */
  #offline { position:fixed; inset:0; z-index:30; display:none; flex-direction:column; align-items:center;
    justify-content:center; gap:18px; background:rgba(31,31,30,0.92); -webkit-backdrop-filter:blur(3px); backdrop-filter:blur(3px); }
  #offline .kicon { width:84px; height:84px; }
  #offline .txt { font-family:var(--body); font-size:20px; color:var(--t2); }
</style></head>
<body>
<div id="board">
  <div class="pane" id="p0"></div><div class="pane" id="p1"></div><div class="pane" id="p2"></div><div class="pane" id="p3"></div>
</div>
<div id="sndhint">🔇 Einmal tippen für Ton</div>
<div id="deckctl"><span id="conndot"></span></div>
<div id="offline"><svg class="kicon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Klaus sucht die Verbindung"><style>.t-pill{transform-box:fill-box;transform-origin:center;animation:t-br 6s ease-in-out var(--delay) infinite}@keyframes t-br{0%,100%{transform:scaleY(0.85)}50%{transform:scaleY(0.95)}}.t-look{transform-box:fill-box;transform-origin:center;animation:t-lk 10s ease-in-out infinite}@keyframes t-lk{0%,10%{transform:translate(0,-4px)}20%,45%{transform:translate(10px,-6px)}55%,80%{transform:translate(-10px,-6px)}90%,100%{transform:translate(0,-4px)}}</style><circle cx="100" cy="100" r="92" fill="#E6E6E3"/><g class="t-look"><rect class="t-pill" style="--delay:0.0s" x="49.0" y="71.0" width="14" height="58" rx="7.0" fill="#1F1F1E"/><rect class="t-pill" style="--delay:0.5s" x="71.0" y="59.0" width="14" height="82" rx="7.0" fill="#1F1F1E"/><rect class="t-pill" style="--delay:1.0s" x="93.0" y="48.0" width="14" height="104" rx="7.0" fill="#1F1F1E"/><rect class="t-pill" style="--delay:0.5s" x="115.0" y="59.0" width="14" height="82" rx="7.0" fill="#1F1F1E"/><rect class="t-pill" style="--delay:0.0s" x="137.0" y="71.0" width="14" height="58" rx="7.0" fill="#1F1F1E"/></g></svg><span class="txt">Verbindung verloren · verbinde neu…</span></div>
<script>
/* Klassisches Script, kein ES-Modul — laeuft auf alten Smart-TV-Browsern. */
var SLOT_MS = 3000, HIST_MS = 2500, TITLE_MS = 20000;
var SCROLL_MS = 180, SCROLL_GAIN = 2.4;   // Remote-Wisch vom Handy: reaktiv, grosser Weg
var SPEAK_MS = 350;                       // Vorlese-Befehle vom Handy abholen
var slots = [{},{},{},{}], active = 0, titles = {};
var sigs = ['','','',''];           // pro Pane: Signatur der zuletzt gerenderten Messages
var atBottom = [true,true,true,true];

/* Lebenszeichen: loadSlots ist der Herzschlag (alle 3s). Zwei Fehlschläge in
   Folge → offline-Schleier; ein Erfolg → wieder da, frisch ziehen. So holt der
   TV nach Server-Neustart oder WLAN-Hänger von allein wieder auf. */
var online = true, failStreak = 0;
function updateConn(){
  var dot = document.getElementById('conndot'); if (dot) dot.className = online ? '' : 'off';
  var ov = document.getElementById('offline'); if (ov) ov.style.display = online ? 'none' : 'flex';
}
function setOnline(ok){
  if (ok){
    failStreak = 0;
    if (!online){ online = true; updateConn(); loadTitles(); loadSlots(); }   // wieder da: frisch nachziehen
  } else {
    failStreak++;
    if (online && failStreak >= 2){ online = false; updateConn(); }
  }
}

/* Sound: Kling beim Drop, Level-up wenn Klaus fertig ist. Browser sperren Ton
   bis zur ersten Berührung, darum einmal entsperren (Tap/Klick/Taste auf dem TV). */
var snd = { in:null, up:null, ready:false };
var seen = [null,null,null,null];   // pro Pane: { base, lastUser, rungKlaus } oder null

/* Vorlesen über den TV: ein wiederverwendbares Audio-Element. Beim Entsperren
   (erste Geste) wird es zusammen mit den Klings geprimt, danach reicht ein
   src-Wechsel — so spielt Klaus' Stimme aus den Fernseher-Boxen, ohne dass der
   TV nochmal eine Geste braucht. Status (idle/playing/paused + Position) geht
   laufend ans Handy zurueck, damit dort die Transportleiste stimmt. */
var ttsAudio = null, ttsConv = '', lastSpeakSeq = -1, lastTsPush = 0;
function pushAudioState(state, t, dur, conv){
  fetch('/api/deck/audio', { method:'POST', credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ state:state, t:t||0, dur:dur||0, convId: (conv!=null?conv:ttsConv) }) }).catch(function(){});
}
function initTTS(){
  ttsAudio = new Audio('/sounds/message-in.ogg'); ttsAudio.preload = 'auto';
  ttsAudio.addEventListener('playing', function(){ if (ttsConv) pushAudioState('playing', ttsAudio.currentTime, ttsAudio.duration||0, ttsConv); });
  ttsAudio.addEventListener('pause',   function(){ if (ttsConv && !ttsAudio.ended) pushAudioState('paused', ttsAudio.currentTime, ttsAudio.duration||0, ttsConv); });
  ttsAudio.addEventListener('ended',   function(){ ttsConv=''; pushAudioState('idle', 0, 0, ''); });
  ttsAudio.addEventListener('timeupdate', function(){
    if (!ttsConv) return;
    var now = Date.now(); if (now - lastTsPush < 600) return; lastTsPush = now;
    pushAudioState('playing', ttsAudio.currentTime, ttsAudio.duration||0, ttsConv);
  });
}
function startTTS(conv, text, voiceId){
  if (!ttsAudio || !text) return;
  void conv; void voiceId;
  stopTTS();
}
function stopTTS(){
  if (ttsAudio){ try { ttsAudio.pause(); ttsAudio.removeAttribute('src'); ttsAudio.load(); } catch(e){} }
  ttsConv = ''; pushAudioState('idle', 0, 0, '');
}
function pullSpeak(){
  fetch('/api/deck/speak', { credentials:'same-origin' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d || typeof d.seq !== 'number' || d.seq === lastSpeakSeq) return;
      if (lastSpeakSeq < 0){ lastSpeakSeq = d.seq; return; }   // erster Lauf: nur merken, alte Befehle nicht nachholen
      lastSpeakSeq = d.seq;
      var a = d.action;
      if (a === 'play') startTTS(d.convId, d.text, d.voiceId);
      else if (a === 'pause'){ if (ttsAudio) ttsAudio.pause(); }
      else if (a === 'resume'){ if (ttsAudio){ var p = ttsAudio.play(); if (p && p.catch) p.catch(function(){}); } }
      else if (a === 'stop') stopTTS();
      else if (a === 'seek'){ if (ttsAudio && isFinite(d.t)){ try { ttsAudio.currentTime = d.t; } catch(e){} } }
    })
    .catch(function(){});
}

function initSound(){
  snd.in = new Audio('/sounds/message-in.ogg'); snd.in.preload = 'auto';
  snd.up = new Audio('/sounds/level-up.ogg');   snd.up.preload = 'auto';
  var unlock = function(){
    if (snd.ready) return;
    snd.ready = true;
    [snd.in, snd.up, ttsAudio].forEach(function(a){ if (!a) return; try {
      a.muted = true;
      var p = a.play();
      if (p && p.then) p.then(function(){ a.pause(); a.currentTime = 0; a.muted = false; }).catch(function(){ a.muted = false; });
      else { a.pause(); a.currentTime = 0; a.muted = false; }
    } catch(e){ a.muted = false; } });
    var h = document.getElementById('sndhint'); if (h) h.style.display = 'none';
    window.removeEventListener('click', unlock);
    window.removeEventListener('keydown', unlock);
    window.removeEventListener('touchstart', unlock);
  };
  window.addEventListener('click', unlock);
  window.addEventListener('keydown', unlock);
  window.addEventListener('touchstart', unlock);
}
function ring(a){ if (!snd.ready || !a) return; try { a.currentTime = 0; a.volume = 0.5; var p = a.play(); if (p && p.catch) p.catch(function(){}); } catch(e){} }
function soundCheck(i, msgs){
  if (!msgs || !msgs.length) return;
  var last = msgs[msgs.length-1];
  var lastUserId = 0;
  for (var k=msgs.length-1;k>=0;k--){ if (msgs[k].author === 'Du'){ lastUserId = msgs[k].id; break; } }
  var st = seen[i];
  if (!st){ seen[i] = { base:last.id, lastUser:lastUserId,
    rungKlaus: (last.author !== 'Du' && last.elapsed_ms ? last.id : 0) }; return; }  // erster Lauf: still
  if (lastUserId > st.base && lastUserId > st.lastUser){ ring(snd.in); st.lastUser = lastUserId; }
  if (last.author !== 'Du' && last.elapsed_ms && last.elapsed_ms > 0 && last.id > st.base && last.id !== st.rungKlaus){
    ring(snd.in);                          // Drop: immer Kling, egal ob Text oder Arbeit
    var hasTools = false; try { var t = JSON.parse(last.tools || '[]'); hasTools = t && t.length > 0; } catch(e){}
    if (hasTools) setTimeout(function(){ ring(snd.up); }, 650);   // nach echter Arbeit zusaetzlich Level-up
    st.rungKlaus = last.id;
  }
}

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* Schlanker Markdown-Renderer, ES5-tauglich (alte TV-Browser). Deckt ab was
   Klaus tatsaechlich nutzt: Fences, Inline-Code, Bold, Italic, Strike, Links,
   Headings, Listen, Zitat, hr. Keine Lib, kein Modul. */
function mdInline(s){
  s = esc(s);
  var codes = [];
  s = s.replace(/`([^`]+)`/g, function(_, c){ codes.push(c); return ''+(codes.length-1)+''; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/(\d+)/g, function(_, k){ return '<code>'+codes[+k]+'</code>'; });
  return s;
}
function md(src){
  var parts = String(src||'').split(/```/), out = [];
  for (var pi=0; pi<parts.length; pi++){
    if (pi % 2 === 1){ out.push('<pre><code>'+esc(parts[pi].replace(/^[a-zA-Z0-9_-]*\n/, ''))+'</code></pre>'); continue; }
    var lines = parts[pi].split('\n'), i = 0;
    while (i < lines.length){
      var ln = lines[i];
      if (/^\s*$/.test(ln)){ i++; continue; }
      var h = ln.match(/^\s*(#{1,3})\s+(.*)$/);
      if (h){ var lv = h[1].length; out.push('<h'+lv+'>'+mdInline(h[2])+'</h'+lv+'>'); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(ln)){ out.push('<hr>'); i++; continue; }
      if (/^\s*>\s?/.test(ln)){ var bq=[]; while(i<lines.length && /^\s*>\s?/.test(lines[i])){ bq.push(mdInline(lines[i].replace(/^\s*>\s?/,''))); i++; } out.push('<blockquote>'+bq.join('<br>')+'</blockquote>'); continue; }
      if (/^\s*[-*+]\s+/.test(ln)){ var ul=[]; while(i<lines.length && /^\s*[-*+]\s+/.test(lines[i])){ ul.push('<li>'+mdInline(lines[i].replace(/^\s*[-*+]\s+/,''))+'</li>'); i++; } out.push('<ul>'+ul.join('')+'</ul>'); continue; }
      if (/^\s*\d+[.)]\s+/.test(ln)){ var ol=[]; while(i<lines.length && /^\s*\d+[.)]\s+/.test(lines[i])){ ol.push('<li>'+mdInline(lines[i].replace(/^\s*\d+[.)]\s+/,''))+'</li>'); i++; } out.push('<ol>'+ol.join('')+'</ol>'); continue; }
      var para=[]; while(i<lines.length && !/^\s*$/.test(lines[i]) && !/^\s*(#{1,3}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[i])){ para.push(mdInline(lines[i])); i++; }
      out.push('<p>'+para.join('<br>')+'</p>');
    }
  }
  return out.join('');
}

/* Kompakte Tool-Spur unter Klaus' Antwort. Nicht live, nur die fertige Summe. */
function toolLine(m){
  var t = [];
  try { t = JSON.parse(m.tools || '[]'); } catch(e){ t = []; }
  if (!t || !t.length) return '';
  var reads=0, edits=0, writes=0, searches=0, bash=0, agents=0;
  for (var k=0;k<t.length;k++){ var n = t[k].name;
    if (n==='Read') reads++; else if (n==='Edit') edits++; else if (n==='Write') writes++;
    else if (n==='Grep'||n==='Glob') searches++; else if (n==='Bash') bash++; else if (n==='Agent') agents++;
  }
  var p = [ t.length+' Tool'+(t.length!==1?'s':'') ];
  if (reads) p.push(reads+' gelesen');
  if (edits+writes) p.push((edits+writes)+' bearbeitet');
  if (searches) p.push(searches+' durchsucht');
  if (bash) p.push(bash+' ausgeführt');
  if (agents) p.push(agents+' Subagent'+(agents>1?'en':''));
  var sec = (m.elapsed_ms && m.elapsed_ms>0) ? '<span class="sec">'+Math.round(m.elapsed_ms/1000)+' s</span> · ' : '';
  return '<div class="tools">'+sec+esc(p.join(' · '))+'</div>';
}

function pane(i){ return document.getElementById('p'+i); }
function titleFor(i){
  var s = slots[i] || {};
  if (!s.convId) return 'Slot '+(i+1);
  return titles[s.convId] || ('Chat '+(i+1));
}

function buildPane(i){
  var el = pane(i);
  el.className = 'pane' + (i===active ? ' active' : '');
  el.innerHTML =
    '<div class="head">'+esc(titleFor(i))+'</div>'+
    '<div class="feed" id="f'+i+'"><div class="empty">'+(slots[i] && slots[i].convId ? 'Lade…' : 'Kein Chat zugewiesen')+'</div></div>'+
    '<div class="pstat" id="ps'+i+'">'+
      '<span class="pill qn" id="pq'+i+'"><span class="qb" id="pqb'+i+'"></span>in Queue</span>'+
      '<span class="pill busy" id="pb'+i+'"><span class="t" id="pbt'+i+'"></span></span>'+
    '</div>';
  var f = document.getElementById('f'+i);
  f.onscroll = (function(idx){ return function(){
    var e = document.getElementById('f'+idx);
    atBottom[idx] = (e.scrollHeight - e.scrollTop - e.clientHeight) < 60;
  };})(i);
}

function renderFeed(i, msgs){
  var f = document.getElementById('f'+i);
  if (!f) return;
  if (!msgs || !msgs.length){ f.innerHTML = '<div class="empty">Noch keine Nachrichten</div>'; sigs[i]=''; return; }
  var last = msgs[msgs.length-1];
  // Signatur faengt auch nachtraegliche Updates (Content/Tools) der letzten Msg.
  var sig = msgs.length + ':' + last.id + ':' + (last.content||'').length + ':' + (last.tools||'').length;
  if (sig === sigs[i]) return;       // nichts Neues → kein Neuzeichnen, kein Scroll-Sprung
  sigs[i] = sig;
  var html = '';
  for (var k=0;k<msgs.length;k++){
    var m = msgs[k];
    var mine = (m.author === 'Du');
    if (mine){
      html += '<div class="msg me"><div class="who">Du</div>'+
              '<div class="bubble"><div class="md">'+md(m.content||'')+'</div></div></div>';
    } else {
      html += '<div class="msg klaus"><div class="who">Klaus</div>'+   // immer Klaus, nie der Engine-Name
              '<div class="agent">'+toolLine(m)+'<div class="md">'+md(m.content||'')+'</div></div></div>';
    }
  }
  f.innerHTML = html;
  if (atBottom[i]) f.scrollTop = f.scrollHeight;
}

function loadHistory(i){
  var s = slots[i] || {};
  if (!s.convId){ renderFeed(i, []); return; }
  var cid = s.convId;
  fetch('/api/history?conversation_id='+encodeURIComponent(cid)+'&limit=40', { credentials:'same-origin' })
    .then(function(r){ return r.json(); })
    .then(function(d){ if ((slots[i]||{}).convId === cid){ soundCheck(i, d && d.messages); renderFeed(i, d && d.messages); } })
    .catch(function(){});
}

function loadSlots(){
  fetch('/api/slots', { credentials:'same-origin' })
    .then(function(r){ if (!r.ok) throw 0; return r.json(); })
    .then(function(d){
      setOnline(true);
      var inc = (d && d.slots);
      if (!inc) return;                  // leere/kaputte Antwort: nichts anfassen, kein Flackern
      for (var i=0;i<4;i++){
        var s = inc[i] || {};
        var cv = String(s.convId||''), ag = String(s.agent||'main');
        if (!slots[i] || slots[i].convId !== cv){
          slots[i] = { convId:cv, agent:ag }; sigs[i]=''; seen[i]=null;
          buildPane(i); loadHistory(i);   // nur die geänderte Pane neu, nicht alle
        }
      }
      var na = (typeof d.activeSlot === 'number') ? Math.max(0,Math.min(d.activeSlot,3)) : active;
      if (na !== active){                 // Aktiv-Wechsel: nur Rahmen umsetzen, Feeds bleiben stehen
        active = na;
        for (var j=0;j<4;j++) pane(j).className = 'pane' + (j===active ? ' active' : '');
      }
    })
    .catch(function(){ setOnline(false); });
}

function loadTitles(){
  fetch('/api/conversations?limit=0', { credentials:'same-origin' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      var cs = (d && d.conversations) || {};
      for (var k=0;k<cs.length;k++){ titles[cs[k].id] = cs[k].title || ''; }
      for (var i=0;i<4;i++){ var h = pane(i).getElementsByClassName('head')[0]; if (h) h.textContent = titleFor(i); }
    })
    .catch(function(){});
}

/* Remote-Scroll: Handy wischt → Server akkumuliert dy → hier abholen und auf den
   aktiven Feed anwenden. atBottom mitziehen, sonst kaempft Autoscroll dagegen. */
function pullScroll(){
  fetch('/api/deck/scroll', { credentials:'same-origin' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      var dy = (Number(d && d.dy) || 0) * SCROLL_GAIN;
      if (!dy) return;
      var f = document.getElementById('f'+active);
      if (!f) return;
      f.scrollTop += dy;
      atBottom[active] = (f.scrollHeight - f.scrollTop - f.clientHeight) < 60;
    })
    .catch(function(){});
}

/* Arbeits-Status + Queue pro Pane: alle 2s den realen Stand ziehen, lokal jede
   Sekunde die Pille hochzählen — wie Desktop/Remote. startedAt = Stream-Beginn
   (epoch ms), 0 = idle. */
var streamStart = [0,0,0,0], queueN = [0,0,0,0];
function loadStatus(){
  fetch('/api/active-streams', { credentials:'same-origin' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      var st = (d && d.streams) || {}, by = {};
      for (var k=0;k<st.length;k++){ by[st[k].convId] = st[k].startedAt || 0; }
      for (var i=0;i<4;i++){ var cv=(slots[i]||{}).convId; streamStart[i] = (cv && by[cv]) ? by[cv] : 0; }
    })
    .catch(function(){});
  fetch('/api/message-queue/counts', { credentials:'same-origin' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      var c = (d && d.counts) || {};
      for (var i=0;i<4;i++){ var cv=(slots[i]||{}).convId; queueN[i] = (cv && c[cv]) ? c[cv] : 0; }
    })
    .catch(function(){});
}
function renderStatus(){
  var now = Date.now();
  for (var i=0;i<4;i++){
    var pb = document.getElementById('pb'+i), pbt = document.getElementById('pbt'+i);
    var pq = document.getElementById('pq'+i), pqb = document.getElementById('pqb'+i);
    if (pb){
      if (streamStart[i] > 0){
        var sec = Math.max(0, Math.floor((now - streamStart[i])/1000));
        pbt.textContent = sec < 60 ? sec+'s' : Math.floor(sec/60)+':'+('0'+(sec%60)).slice(-2);
        pb.style.display = 'inline-flex';
      } else { pb.style.display = 'none'; }
    }
    if (pq){
      if (queueN[i] > 0){ pqb.textContent = queueN[i]; pq.style.display = 'inline-flex'; }
      else { pq.style.display = 'none'; }
    }
  }
}

initTTS(); initSound();
for (var i=0;i<4;i++) buildPane(i);
loadTitles(); loadSlots(); loadStatus();
setInterval(loadSlots, SLOT_MS);
setInterval(function(){ for (var i=0;i<4;i++) loadHistory(i); }, HIST_MS);
setInterval(loadTitles, TITLE_MS);
setInterval(pullScroll, SCROLL_MS);
setInterval(pullSpeak, SPEAK_MS);
setInterval(loadStatus, 2000);
setInterval(renderStatus, 1000);
</script>
</body></html>
"""


@router.get("/deck", response_class=HTMLResponse)
async def deck():
    # Eigenständige, modul-freie Board-Seite. Smart-TV-Browser (Samsung Tizen,
    # Chromium 56–60) können modernes JS (fetch/async/const — siehe /tv läuft auf
    # dem TV), aber KEINE ES-Module. Die React-App lädt per <script type="module">
    # und wird vom TV ignoriert → schwarz. Darum hier ein klassisches <script>,
    # kein React, kein Bundle: nur die vier Zielchats lesen, per Polling. Eingabe
    # läuft komplett übers Handy (/remote). Auth über das mon_-Cookie (XHR same-origin).
    return HTMLResponse(_DECK_BOARD_HTML, headers=INDEX_NO_CACHE)


@router.post("/api/deck/pane-input")
async def deck_pane_input(payload: dict = Body(...)):
    """Klaus Deck Phone-Control: pusht ein Transkript in den Composer von Pane N.
    Wie /api/pane-input (KlausFlow), aber Cookie-/IP-authentifiziert statt Bearer —
    läuft im Browser aus derselben PWA. Der Monitor-ChatPane mit paneIndex N-1
    empfängt es und sendet die Nachricht in seinen Chat."""
    pane = payload.get("pane")
    text = payload.get("text", "")
    focus = bool(payload.get("focus"))
    if not isinstance(pane, int) or pane < 1 or pane > MAX_SLOTS:
        return JSONResponse({"error": f"pane must be int in 1..{MAX_SLOTS}"}, status_code=400)
    # Focus-only: der PTT-Client meldet beim Aufnahme-Start (erster Druck) nur die
    # Ziel-Pane, ohne Transkript. Die App springt dann sofort hin, gesendet wird
    # nichts. Der echte Text kommt erst beim zweiten Druck als normaler pane.input.
    if focus and (not isinstance(text, str) or not text.strip()):
        from streaming import broadcast_pane_focus
        delivered = await broadcast_pane_focus(pane)
        return JSONResponse({"ok": True, "focus": True, "delivered": delivered, "pane": pane})
    if not isinstance(text, str) or not text.strip():
        return JSONResponse({"error": "text must be non-empty string"}, status_code=400)
    clean_text = text.strip()[:8000]
    from streaming import broadcast_pane_input, should_drop_duplicate_pane_input
    if should_drop_duplicate_pane_input(pane, clean_text):
        return JSONResponse({"ok": True, "duplicate": True, "delivered": False, "pane": pane})
    delivered = await broadcast_pane_input(pane, clean_text)
    return JSONResponse({"ok": True, "delivered": delivered, "pane": pane})


@router.post("/api/deck/stop")
async def deck_stop(payload: dict = Body(...)):
    """Klaus Deck: laufenden Agenten einer Session vom Handy aus stoppen."""
    conv_id = str(payload.get("convId", "")).strip()
    if not conv_id:
        return JSONResponse({"error": "convId required"}, status_code=400)
    from streaming import request_stop
    stopped = await request_stop(conv_id)
    return JSONResponse({"ok": True, "stopped": stopped})


@router.get("/api/deck/logout")
async def deck_logout():
    """Monitor (TV) sauber trennen: kurzlebiges Cookie löschen, zurück zur
    Koppel-Seite. Das Handy muss danach neu koppeln, der TV bleibt nicht verbunden."""
    resp = RedirectResponse(url="/tv", status_code=302)
    resp.delete_cookie("agent_auth", path="/")
    return resp


@router.post("/api/deck/disconnect-all")
async def deck_disconnect_all(request: Request):
    """Alle gekoppelten Bildschirme trennen (vom Hauptgerät). Widerruft jedes
    Monitor-Token, der nächste Poll eines TVs fällt zurück auf die Koppel-Seite.
    Der geteilte Vorlese-/Wisch-Kanal wird gleich mit zurückgesetzt, damit kein
    vergessener TV noch Befehle aus dem Puffer abfängt."""
    provided = request.cookies.get("agent_auth", "") or request.query_params.get("token", "")
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        provided = auth_header[7:].strip() or provided
    if current_token() and not token_matches(provided):
        return JSONResponse({"error": "nur vom Hauptgerät"}, status_code=403)
    n = revoke_monitor_tokens()
    _deck_scroll.update({"pane": 0, "dy": 0.0})
    _deck_speak.update({"action": "stop"})
    _deck_speak["seq"] += 1
    _deck_audio.update({"state": "idle", "convId": "", "t": 0.0, "dur": 0.0})
    return JSONResponse({"ok": True, "disconnected": n})


@router.get("/api/deck/monitors")
async def deck_monitors(request: Request):
    """Liste der gekoppelten Bildschirme (Name + seit wann), nur vom Hauptgerät.
    Speist die „Wo bin ich angemeldet"-Ansicht in der Remote."""
    provided = request.cookies.get("agent_auth", "") or request.query_params.get("token", "")
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        provided = auth_header[7:].strip() or provided
    if current_token() and not token_matches(provided):
        return JSONResponse({"error": "nur vom Hauptgerät"}, status_code=403)
    return JSONResponse({"monitors": list_monitor_tokens()})


@router.post("/api/deck/monitors/revoke")
async def deck_monitor_revoke(request: Request, payload: dict = Body(...)):
    """Einen gekoppelten Bildschirm gezielt trennen (vom Hauptgerät), per id aus
    der Liste. Der nächste Poll dieses TVs fällt auf die Koppel-Seite zurück."""
    provided = request.cookies.get("agent_auth", "") or request.query_params.get("token", "")
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        provided = auth_header[7:].strip() or provided
    if current_token() and not token_matches(provided):
        return JSONResponse({"error": "nur vom Hauptgerät"}, status_code=403)
    mid = str(payload.get("id", "")).strip()
    if not mid:
        return JSONResponse({"error": "id fehlt"}, status_code=400)
    return JSONResponse({"ok": revoke_monitor_token(mid)})


@router.get("/api/deck/me")
async def deck_me(request: Request):
    """Der TV fragt seinen eigenen Modus ab (chat|fokus). Identifikation über sein
    Monitor-Cookie/Token, das es beim Pairing bekommen hat. Haupt-Token = chat."""
    provided = request.cookies.get("agent_auth", "") or request.query_params.get("token", "")
    return JSONResponse({"mode": monitor_mode_for(provided)})


@router.post("/api/deck/monitors/mode")
async def deck_monitor_mode(request: Request, payload: dict = Body(...)):
    """Modus eines gekoppelten Bildschirms umschalten (vom Hauptgerät), per id aus
    der Liste. Der TV zieht den neuen Modus beim nächsten /api/deck/me-Poll."""
    provided = request.cookies.get("agent_auth", "") or request.query_params.get("token", "")
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        provided = auth_header[7:].strip() or provided
    if current_token() and not token_matches(provided):
        return JSONResponse({"error": "nur vom Hauptgerät"}, status_code=403)
    mid = str(payload.get("id", "")).strip()
    mode = str(payload.get("mode", "")).strip()
    if not mid:
        return JSONResponse({"error": "id fehlt"}, status_code=400)
    if mode not in ("chat", "fokus"):
        return JSONResponse({"error": "mode muss chat oder fokus sein"}, status_code=400)
    return JSONResponse({"ok": set_monitor_mode(mid, mode)})



# ── Klaus Deck — Remote-Scroll (Handy wischt, Monitor scrollt den aktiven Pane) ──
# Bewusst Poll-basiert wie der Rest des Decks (robust auf alter TV-Engine, kein WS).
# Das Handy schickt relative Pixel-Deltas, die hier akkumuliert werden; der Monitor
# holt die Summe und leert den Puffer, damit nichts verlorengeht.
_deck_scroll: dict = {"pane": 0, "dy": 0.0}


@router.post("/api/deck/scroll")
async def deck_scroll_push(payload: dict = Body(...)):
    pane = payload.get("pane")
    if not isinstance(pane, int) or pane < 1 or pane > MAX_SLOTS:
        return JSONResponse({"error": f"pane must be int in 1..{MAX_SLOTS}"}, status_code=400)
    try:
        dy = float(payload.get("dy", 0))
    except (TypeError, ValueError):
        return JSONResponse({"error": "dy must be a number"}, status_code=400)
    if _deck_scroll["pane"] != pane:
        _deck_scroll["pane"] = pane
        _deck_scroll["dy"] = 0.0
    _deck_scroll["dy"] += dy
    return JSONResponse({"ok": True})


@router.get("/api/deck/scroll")
async def deck_scroll_pull():
    pane = _deck_scroll["pane"]
    dy = _deck_scroll["dy"]
    _deck_scroll["dy"] = 0.0
    return JSONResponse({"pane": pane, "dy": dy})


# ── Deck — alter Vorlesen-Status (TTS ist im Public-Core deaktiviert) ──────────
# Gleiche Poll-Logik wie der Scroll: zwei Kanäle, kein WS (alte TV-Engine).
#   Befehl  (Handy → TV):  _deck_speak  — legacy play/pause/resume/stop/seek.
#   Status  (TV → Handy):  _deck_audio  — idle/playing/paused + Position/Dauer.
# Der Befehl trägt eine monoton steigende seq; der TV führt jede seq genau einmal
# aus (merkt sich die letzte). TTS-Ausgabe ist entfernt.
_DECK_SPEAK_ACTIONS = ("play", "pause", "resume", "stop", "seek")
_deck_speak: dict = {"seq": 0, "action": "", "convId": "", "text": "", "voiceId": "", "t": 0.0}
_deck_audio: dict = {"state": "idle", "convId": "", "t": 0.0, "dur": 0.0}


@router.post("/api/deck/speak")
async def deck_speak_push(payload: dict = Body(...)):
    action = str(payload.get("action", ""))
    if action not in _DECK_SPEAK_ACTIONS:
        return JSONResponse({"error": f"action must be one of {_DECK_SPEAK_ACTIONS}"}, status_code=400)
    try:
        t = float(payload.get("t", 0) or 0)
    except (TypeError, ValueError):
        t = 0.0
    _deck_speak["seq"] += 1
    _deck_speak["action"] = action
    _deck_speak["convId"] = str(payload.get("convId", "") or "")
    _deck_speak["text"] = str(payload.get("text", "") or "")
    _deck_speak["voiceId"] = str(payload.get("voiceId", "") or "")
    _deck_speak["t"] = t
    return JSONResponse({"ok": True, "seq": _deck_speak["seq"]})


@router.get("/api/deck/speak")
async def deck_speak_pull():
    return JSONResponse(dict(_deck_speak))


@router.post("/api/deck/audio")
async def deck_audio_push(payload: dict = Body(...)):
    state = str(payload.get("state", "idle"))
    if state not in ("idle", "playing", "paused"):
        state = "idle"
    try:
        t = float(payload.get("t", 0) or 0)
        dur = float(payload.get("dur", 0) or 0)
    except (TypeError, ValueError):
        t, dur = 0.0, 0.0
    _deck_audio.update({"state": state, "convId": str(payload.get("convId", "") or ""), "t": t, "dur": dur})
    return JSONResponse({"ok": True})


@router.get("/api/deck/audio")
async def deck_audio_pull():
    return JSONResponse(dict(_deck_audio))


# ── Klaus Deck — Monitor-Pairing (QR vom fremden Bildschirm, Freigabe vom Handy) ──
# Ein fremder Monitor öffnet /tv (ohne Login), zeigt einen QR. Das authentifizierte
# Handy scannt ihn (landet in /remote?pair=<user_code>) und bestätigt einmal —
# erst dann bekommt der Monitor ein kurzlebiges Token und lädt das Deck. So muss
# am TV nie eine Mail oder ein Code getippt werden.

_deck_pairings: dict[str, dict] = {}  # device_code -> {user_code, confirmed, token, created}
_PAIR_TTL = 300  # 5 min bis zur Bestätigung
# /api/deck/pair/new ist token-frei und haengt am oeffentlichen Deck. Ohne Bremse
# liesse sich der Speicher mit Pairing-Eintraegen fluten. IP-Sliding-Window plus
# globale Obergrenze als RAM-Backstop gegen verteilte Anfragen.
_PAIR_MAX_OPEN = 200
_PAIR_RATE_MAX = 15
_PAIR_RATE_WINDOW = 300
_pair_rate: dict[str, list[float]] = {}  # ip -> [timestamps]


def _pair_rate_ok(ip: str) -> bool:
    now = time.time()
    hits = [t for t in _pair_rate.get(ip, []) if now - t < _PAIR_RATE_WINDOW]
    if len(hits) >= _PAIR_RATE_MAX:
        _pair_rate[ip] = hits
        return False
    hits.append(now)
    _pair_rate[ip] = hits
    return True


def _prune_pairings() -> None:
    now = time.time()
    for dc, p in list(_deck_pairings.items()):
        if now - p["created"] > _PAIR_TTL and not p["confirmed"]:
            _deck_pairings.pop(dc, None)
    # Rate-Fenster ebenfalls putzen, damit das IP-Dict nicht unbegrenzt waechst.
    for ip in list(_pair_rate.keys()):
        fresh = [t for t in _pair_rate[ip] if now - t < _PAIR_RATE_WINDOW]
        if fresh:
            _pair_rate[ip] = fresh
        else:
            _pair_rate.pop(ip, None)


@router.post("/api/deck/pair/new")
async def deck_pair_new(request: Request):
    """Monitor fordert einen Pairing-Code an (kein Login nötig)."""
    _prune_pairings()
    ip = request.client.host if request.client else "?"
    if not _pair_rate_ok(ip):
        return JSONResponse({"error": "zu viele Anfragen"}, status_code=429)
    if len(_deck_pairings) >= _PAIR_MAX_OPEN:
        return JSONResponse({"error": "Pairing ausgelastet, kurz warten"}, status_code=503)
    device_code = secrets.token_urlsafe(18)
    # 6-stelliger Code: gut vom TV ablesbar, in der App schnell tippbar. Freischalten
    # geht ohnehin nur vom Hauptgerät (confirm braucht das Haupt-Token), der Code
    # schuetzt also nur gegen versehentliches Falsch-Koppeln.
    active = {p["user_code"] for p in _deck_pairings.values() if not p["confirmed"]}
    user_code = f"{secrets.randbelow(900000) + 100000}"
    while user_code in active:
        user_code = f"{secrets.randbelow(900000) + 100000}"
    _deck_pairings[device_code] = {"user_code": user_code, "confirmed": False, "token": None, "created": time.time()}
    return JSONResponse({"device_code": device_code, "user_code": user_code})


@router.get("/api/deck/pair/qr")
async def deck_pair_qr(data: str):
    """SVG-QR für eine beliebige URL (serverseitig, ohne externe Lib im Browser)."""
    import io
    import qrcode
    import qrcode.image.svg
    img = qrcode.make(data[:512], image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    return Response(content=buf.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "no-store"})


@router.get("/api/deck/pair/poll")
async def deck_pair_poll(device_code: str):
    """Monitor pollt, ob das Handy schon bestätigt hat. Token wird einmalig abgeholt."""
    p = _deck_pairings.get(device_code)
    if not p:
        return JSONResponse({"status": "expired"})
    if not p["confirmed"] and time.time() - p["created"] > _PAIR_TTL:
        _deck_pairings.pop(device_code, None)
        return JSONResponse({"status": "expired"})
    if p["confirmed"] and p["token"]:
        tok = p["token"]
        _deck_pairings.pop(device_code, None)
        return JSONResponse({"status": "confirmed", "token": tok})
    return JSONResponse({"status": "pending"})


@router.post("/api/deck/pair/confirm")
async def deck_pair_confirm(request: Request, payload: dict = Body(...)):
    """Handy bestätigt einen Monitor. Nur mit dem Haupt-Token (nicht von einem
    bereits gepairten Monitor), damit ein Monitor keine weiteren freischalten kann."""
    provided = request.cookies.get("agent_auth", "") or request.query_params.get("token", "")
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        provided = auth_header[7:].strip() or provided
    if current_token() and not token_matches(provided):
        return JSONResponse({"error": "nur vom Hauptgerät"}, status_code=403)
    user_code = str(payload.get("user_code", "")).strip()
    name = str(payload.get("name", "")).strip()
    if not user_code:
        return JSONResponse({"error": "user_code fehlt"}, status_code=400)
    for dc, p in _deck_pairings.items():
        if p["user_code"] == user_code and not p["confirmed"]:
            if time.time() - p["created"] > _PAIR_TTL:
                return JSONResponse({"error": "Code abgelaufen"}, status_code=410)
            p["confirmed"] = True
            # Mehrere Bildschirme dürfen koexistieren (synchrone Spiegel desselben
            # Decks). Vergessene TVs verwaltet der Nutzer über die Bildschirm-Liste
            # in der Remote, statt dass jedes Koppeln blind alle alten rauswirft.
            p["token"] = mint_monitor_token(name)
            return JSONResponse({"ok": True})
    return JSONResponse({"error": "Code unbekannt oder schon benutzt"}, status_code=404)


_TV_HTML = """<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Klaus Deck</title>
<style>
  :root { --bg:#141312; --t1:#ece9e4; --t3:#8a857d; --accent:#d97757; }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--t1);
    font-family:system-ui,-apple-system,sans-serif; }
  .wrap { height:100dvh; overflow:hidden; display:flex; flex-direction:column; align-items:center;
    justify-content:center; gap:20px; padding:24px; text-align:center; }
  .eyebrow { font-size:14px; letter-spacing:.14em; text-transform:uppercase; color:var(--t3); }
  h1 { font-size:30px; font-weight:600; margin:0; }
  .qr { background:#fff; padding:28px; border-radius:24px;
    width:70vmin; height:70vmin;
    display:flex; align-items:center; justify-content:center; }
  .qr svg, .qr img { width:100%; height:100%; display:block; }
  .hint { font-size:17px; color:var(--t3); max-width:460px; line-height:1.5; }
  .code { font-size:13vmin; font-weight:700; letter-spacing:.12em; color:var(--accent);
    font-variant-numeric:tabular-nums; line-height:1; }
  .state { font-size:15px; color:var(--accent); min-height:22px; }
</style></head>
<body><div class="wrap">
  <div class="eyebrow">Klaus Deck</div>
  <h1>Mit dem Handy koppeln</h1>
  <div class="qr" id="qr"></div>
  <div class="code" id="code"></div>
  <div class="hint">In der App „Remote" öffnen und diese Zahl eintippen (oder den QR scannen). Dann erscheint hier dein Deck.</div>
  <div class="state" id="state"></div>
</div>
<script>
let deviceCode = null, dead = false;
async function start() {
  try {
    const r = await fetch('/api/deck/pair/new', { method:'POST' });
    const d = await r.json();
    deviceCode = d.device_code;
    const remoteOrigin = '__REMOTE_ORIGIN__' || location.origin;
    const target = remoteOrigin + '/remote?pair=' + encodeURIComponent(d.user_code);
    document.getElementById('qr').innerHTML =
      '<img src="/api/deck/pair/qr?data=' + encodeURIComponent(target) + '" alt="QR">';
    document.getElementById('code').textContent = d.user_code;
    poll();
  } catch (e) { setState('Verbindung fehlgeschlagen, lade neu…'); setTimeout(()=>location.reload(), 3000); }
}
function setState(s){ document.getElementById('state').textContent = s; }
async function poll() {
  if (dead) return;
  try {
    const r = await fetch('/api/deck/pair/poll?device_code=' + encodeURIComponent(deviceCode));
    const d = await r.json();
    if (d.status === 'confirmed' && d.token) {
      dead = true; setState('Gekoppelt. Lade Deck…');
      location.href = '/deck?token=' + encodeURIComponent(d.token);
      return;
    }
    if (d.status === 'expired') { setState('Code abgelaufen, neuer Code…'); return start(); }
  } catch (e) {}
  setTimeout(poll, 2000);
}
start();
</script>
</body></html>"""


# Origin, auf die der QR zeigt: dort muss das koppelnde Handy bereits mit dem
# Haupt-Token eingeloggt sein (Cookie). Das ist exakt die Adresse, über die
# der Nutzer die App nutzt — Tailscale Serve auf 443 (HTTPS, ohne Port). Ein
# abweichendes Schema oder ein Port wie :8890 wäre ein anderer Origin ohne
# Login-Cookie, dann landet das Handy auf /login statt im Pairing.
DECK_REMOTE_ORIGIN = os.environ.get(
    "DECK_REMOTE_ORIGIN", "https://agent-control.example.ts.net"
)


@router.get("/tv", response_class=HTMLResponse)
async def deck_tv():
    html = _TV_HTML.replace("__REMOTE_ORIGIN__", DECK_REMOTE_ORIGIN)
    return HTMLResponse(html, headers=INDEX_NO_CACHE)
