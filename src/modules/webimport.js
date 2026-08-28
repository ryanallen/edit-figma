/**
 * 🦞 ClawDaddy Web Import
 *
 * Pull a rendered web page (or a single element inside it) out of a headless
 * Chrome and rebuild it as native Figma nodes. Useful for turning a live
 * Storybook story, component, or any URL into a Figma frame / component without
 * hand-measuring anything.
 *
 * How it works:
 *   1. Node side  — drive Chrome over CDP, walk the DOM, and capture each
 *      element's geometry + computed styles + inline SVG + image URLs.
 *   2. Figma side — stream that tree through the eval bridge and rebuild it as
 *      frames / text / vectors. Images are loaded by URL inside the plugin
 *      (manifest allows all domains) in small batches so no single eval call
 *      approaches the 25s plugin timeout.
 *
 * The build is split into short eval calls on purpose: define → store tree →
 * build structure → load images (batched) → optionally convert to a component.
 */

import { spawn } from "child_process";
import { existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";

// ---------- Chrome discovery ----------

const CHROME_CANDIDATES = [
  process.env.CLAWDADDY_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
].filter(Boolean);

export function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error(
    "No Chrome/Chromium found. Set CLAWDADDY_CHROME to a Chrome binary path."
  );
}

// ---------- DOM extraction over CDP ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The function injected into the page. Returns a JSON tree of the target
// element: geometry relative to the target root, plus the computed styles we
// need to rebuild the node in Figma. Leaf text elements carry `text`; <svg>
// carry their markup; <img> carry the resolved src.
const PAGE_EXTRACT = `(sel) => {
  const host = document.querySelector('#storybook-root') || document.body;
  let start;
  if (sel) { start = document.querySelector(sel); }
  if (!start) {
    const kids = [...host.children].filter(c => { const r=c.getBoundingClientRect(); return r.width>0 && r.height>0; });
    start = kids.length === 1 ? kids[0] : host;
  }
  const base = start.getBoundingClientRect();
  const px = v => Math.round(v*100)/100;
  const directText = el => {
    let t=''; for (const n of el.childNodes) if (n.nodeType===3) t += n.textContent;
    return t.replace(/\\s+/g,' ').trim();
  };
  const styleOf = el => {
    const c = getComputedStyle(el);
    const bw = ['Top','Right','Bottom','Left'].map(s=>parseFloat(c['border'+s+'Width'])||0);
    const br = ['TopLeft','TopRight','BottomRight','BottomLeft'].map(s=>parseFloat(c['border'+s+'Radius'])||0);
    return {
      color:c.color, bg:c.backgroundColor,
      bgImage:(c.backgroundImage&&c.backgroundImage!=='none')?c.backgroundImage:null,
      bgSize:c.backgroundSize,
      font:c.fontFamily, size:parseFloat(c.fontSize)||0, weight:c.fontWeight,
      lh:c.lineHeight==='normal'?null:(parseFloat(c.lineHeight)||null),
      ls:c.letterSpacing==='normal'?0:(parseFloat(c.letterSpacing)||0),
      align:c.textAlign, deco:c.textDecorationLine,
      bw, bColor:c.borderTopColor, bStyle:c.borderTopStyle, br,
      shadow:c.boxShadow==='none'?null:c.boxShadow,
      opacity:parseFloat(c.opacity), overflow:c.overflow
    };
  };
  const walk = el => {
    const r = el.getBoundingClientRect();
    if (r.width<=0 || r.height<=0) return null;
    const tag = el.tagName.toLowerCase();
    const node = { tag, x:px(r.left-base.left), y:px(r.top-base.top), w:px(r.width), h:px(r.height), s:styleOf(el) };
    if (tag==='svg'){ node.svg = el.outerHTML; return node; }
    if (tag==='img'){ node.img = el.currentSrc||el.src; node.fit = getComputedStyle(el).objectFit; return node; }
    const kids = [...el.children];
    if (kids.length===0){ const t=directText(el); if (t) node.text=t; return node; }
    node.children = [];
    for (const ch of kids){ const c = walk(ch); if (c) node.children.push(c); }
    return node;
  };
  return JSON.stringify(walk(start));
}`;

/**
 * Launch Chrome, load the URL, and extract the DOM tree of the target element.
 * @returns {Promise<{tree:object,w:number,h:number}>}
 */
export async function extractDom({
  url,
  selector = null,
  width = 1440,
  height = 3200,
  scale = 1,
  chromePath = null,
  settleMs = 900
}) {
  const chrome = chromePath || findChrome();
  const port = 9200 + Math.floor(Math.random() * 700);
  const userDir = mkdtempSync(join(tmpdir(), "clawdaddy-cdp-"));
  const proc = spawn(
    chrome,
    [
      "--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--force-device-scale-factor=" + scale,
      "--window-size=" + width + "," + height,
      "--remote-debugging-port=" + port,
      "--no-first-run", "--no-default-browser-check",
      "--user-data-dir=" + userDir, "about:blank"
    ],
    { stdio: "ignore" }
  );

  let msgId = 0;
  const pending = new Map();
  const events = [];
  const waiters = [];

  const getJSON = async (path) => {
    let last;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch("http://127.0.0.1:" + port + path);
        if (r.ok) return r.json();
      } catch (e) { last = e; }
      await sleep(100);
    }
    throw new Error("Chrome CDP not reachable: " + (last && last.message));
  };

  try {
    const ver = await getJSON("/json/version");
    const ws = new WebSocket(ver.webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });

    ws.on("message", (raw) => {
      const d = JSON.parse(raw.toString());
      if (d.id && pending.has(d.id)) {
        const p = pending.get(d.id); pending.delete(d.id);
        d.error ? p.reject(new Error(JSON.stringify(d.error))) : p.resolve(d.result);
      } else if (d.method) {
        events.push(d);
        for (const w of waiters.slice()) if (w.method === d.method) { waiters.splice(waiters.indexOf(w), 1); w.resolve(d); }
      }
    });

    const cmd = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      });
    const waitEvent = (method, timeout = 15000) => {
      if (events.find((e) => e.method === method)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        waiters.push({ method, resolve });
        setTimeout(() => reject(new Error("timeout " + method)), timeout);
      });
    };

    const { targetId } = await cmd("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cmd("Target.attachToTarget", { targetId, flatten: true });
    const send = (m, p) => cmd(m, p, sessionId);

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url });
    await waitEvent("Page.loadEventFired");
    await send("Runtime.evaluate", { expression: "document.fonts.ready.then(()=>true)", awaitPromise: true });
    await sleep(settleMs);

    const expr = "(" + PAGE_EXTRACT + ")(" + JSON.stringify(selector) + ")";
    const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (res.exceptionDetails) throw new Error("extract failed: " + JSON.stringify(res.exceptionDetails));
    const tree = JSON.parse(res.result.value);
    ws.close();
    return { tree, w: tree.w, h: tree.h };
  } finally {
    try { proc.kill(); } catch {}
  }
}

// ---------- Figma-side builder (runs in the plugin via the eval bridge) ----------

// Installed once as globalThis.__cd. No template literals / ${} inside — this
// whole string is itself carried in a template literal below. Uses only the
// Figma plugin API (createFrame/createText/createNodeFromSvg/createImageAsync).
export const BUILDER_SRC = `
globalThis.__cd = (function(){
  var FONT = "__FONT__";
  var WEIGHTS = { "100":"Thin","200":"Extra Light","300":"Light","400":"Regular","500":"Medium","600":"Semi Bold","700":"Bold","800":"Extra Bold","900":"Black" };
  function styleForWeight(w){ var n = parseInt(w,10)||400; n = Math.round(n/100)*100; if(n<100)n=100; if(n>900)n=900; return WEIGHTS[String(n)]||"Regular"; }
  var fontsReady = false;
  async function ensureFonts(){
    if(fontsReady) return;
    var styles = ["Thin","Extra Light","Light","Regular","Medium","Semi Bold","Bold","Extra Bold","Black"];
    for(var i=0;i<styles.length;i++){ try{ await figma.loadFontAsync({family:FONT,style:styles[i]}); }catch(e){} }
    fontsReady = true;
  }
  function col(str){
    if(!str) return null;
    var m = str.match(/rgba?\\(([^)]+)\\)/); if(!m) return null;
    var p = m[1].split(",").map(function(s){return parseFloat(s.trim());});
    var a = p.length>3 ? p[3] : 1;
    if(a===0) return null;
    return { r:(p[0]||0)/255, g:(p[1]||0)/255, b:(p[2]||0)/255, a:a };
  }
  function solid(c){ return { type:"SOLID", color:{r:c.r,g:c.g,b:c.b}, opacity:c.a }; }
  function urlFrom(bgImage){ if(!bgImage) return null; var m = bgImage.match(/url\\(["']?([^"')]+)["']?\\)/); return m?m[1]:null; }
  function shadows(str){
    if(!str) return [];
    var parts = str.split(/,(?![^(]*\\))/);
    var out = [];
    for(var i=0;i<parts.length;i++){
      var seg = parts[i].trim(); if(!seg || seg.indexOf("inset")>=0) continue;
      var cm = seg.match(/rgba?\\([^)]+\\)/); if(!cm) continue;
      var c = col(cm[0]); if(!c) continue;
      var nums = seg.replace(cm[0],"").trim().split(/\\s+/).map(function(s){return parseFloat(s);}).filter(function(n){return !isNaN(n);});
      out.push({ type:"DROP_SHADOW", color:{r:c.r,g:c.g,b:c.b,a:c.a}, offset:{x:nums[0]||0,y:nums[1]||0}, radius:nums[2]||0, spread:nums[3]||0, visible:true, blendMode:"NORMAL" });
    }
    return out;
  }
  function boxed(s){
    if(col(s.bg)) return true;
    if(s.bgImage && urlFrom(s.bgImage)) return true;
    if(s.br && (s.br[0]||s.br[1]||s.br[2]||s.br[3])) return true;
    if(s.bw && s.bStyle!=="none" && (s.bw[0]||s.bw[1]||s.bw[2]||s.bw[3])) return true;
    return false;
  }
  function applyBox(f, node){
    var s = node.s, fills = [];
    var bg = col(s.bg); if(bg) fills.push(solid(bg));
    if(node.img){ __cd._imgTasks.push({ id:f.id, url:node.img, fit:node.fit }); }
    else if(s.bgImage){ var u = urlFrom(s.bgImage); if(u) __cd._imgTasks.push({ id:f.id, url:u, fit: s.bgSize==="contain"?"contain":"cover" }); }
    f.fills = fills;
    if(s.bw && s.bStyle!=="none"){ var maxw = Math.max(s.bw[0],s.bw[1],s.bw[2],s.bw[3]); var bc = col(s.bColor); if(maxw>0 && bc){ f.strokes=[solid(bc)]; f.strokeWeight=maxw; f.strokeAlign="INSIDE"; } }
    if(s.br){ f.topLeftRadius=s.br[0]||0; f.topRightRadius=s.br[1]||0; f.bottomRightRadius=s.br[2]||0; f.bottomLeftRadius=s.br[3]||0; }
    var eff = shadows(s.shadow); if(eff.length) f.effects = eff;
    if(s.opacity<1) f.opacity = s.opacity;
    f.clipsContent = false;
  }
  function mkText(node){
    var s = node.s, t = figma.createText();
    t.fontName = { family:FONT, style: styleForWeight(s.weight) };
    t.fontSize = Math.max(s.size||16, 1);
    t.characters = node.text;
    if(s.lh) t.lineHeight = { value:s.lh, unit:"PIXELS" };
    if(s.ls) t.letterSpacing = { value:s.ls, unit:"PIXELS" };
    var c = col(s.color)||{r:0,g:0,b:0,a:1}; t.fills = [solid(c)];
    if(s.deco && s.deco.indexOf("underline")>=0) t.textDecoration = "UNDERLINE";
    else if(s.deco && s.deco.indexOf("line-through")>=0) t.textDecoration = "STRIKETHROUGH";
    t.textAlignHorizontal = s.align==="center"?"CENTER":(s.align==="right"||s.align==="end")?"RIGHT":"LEFT";
    return t;
  }
  async function make(node, px, py){
    var relx = node.x - px, rely = node.y - py;
    var w = Math.max(node.w, 0.01), h = Math.max(node.h, 0.01);
    // svg icon
    if(node.svg){
      var svg = node.svg;
      if(svg.indexOf("currentColor")>=0){ var cc = col(node.s.color); if(cc){ var hex = "rgb("+Math.round(cc.r*255)+","+Math.round(cc.g*255)+","+Math.round(cc.b*255)+")"; svg = svg.split("currentColor").join(hex); } }
      var n;
      try { n = figma.createNodeFromSvg(svg); } catch(e){ n = figma.createFrame(); }
      n.x = relx; n.y = rely;
      try { n.resize(w, h); } catch(e){}
      return n;
    }
    // leaf text
    if(node.text != null && !node.children){
      var lh = node.s.lh || (node.s.size||16)*1.35;
      var singleLine = node.h < 1.6*lh;
      if(!boxed(node.s)){
        var t = mkText(node);
        if(singleLine){
          // auto-width so the substitute font never wraps; keep the DOM box's
          // top-left, vertically centring the line within the original box.
          t.textAutoResize = "WIDTH_AND_HEIGHT";
          t.x = relx; t.y = rely + Math.max(0,(h - t.height)/2);
        } else {
          // paragraph: keep DOM width, let height flow.
          t.textAutoResize = "HEIGHT"; try{ t.resize(w, t.height); }catch(e){}
          t.x = relx; t.y = rely;
        }
        return t;
      }
      var fb = figma.createFrame(); fb.x=relx; fb.y=rely; fb.resize(w,h); applyBox(fb, node);
      var tt = mkText(node); tt.textAutoResize = "WIDTH_AND_HEIGHT";
      tt.x = Math.max(0,(w - tt.width)/2); tt.y = Math.max(0,(h - tt.height)/2);
      fb.appendChild(tt); return fb;
    }
    // container / image box
    var f = figma.createFrame(); f.x=relx; f.y=rely; f.resize(w,h); applyBox(f, node);
    if(node.children){ for(var i=0;i<node.children.length;i++){ var ch = await make(node.children[i], node.x, node.y); f.appendChild(ch); } }
    return f;
  }
  return {
    _imgTasks: [],
    build: async function(opts){
      await ensureFonts();
      // Optionally target a named page (create if missing; clear if replace).
      if(opts.page){
        await figma.loadAllPagesAsync();
        var pg = figma.root.children.find(function(p){ return p.name===opts.page; });
        if(!pg){ pg = figma.createPage(); pg.name = opts.page; }
        else if(opts.replace){ var kids = pg.children.slice(); for(var k=0;k<kids.length;k++) kids[k].remove(); }
        await figma.setCurrentPageAsync(pg);
      }
      this._imgTasks = [];
      var tree = globalThis.__cdTree;
      var root = await make(tree, tree.x, tree.y);
      // If the captured root is itself transparent, its on-page whiteness came
      // from the document body — fill it so it doesn't read as see-through on
      // Figma's canvas. Skip when the root already paints its own background
      // (e.g. a modal scrim), and when the caller passes no background.
      if(opts.background && root.type==="FRAME" && (!root.fills || root.fills.length===0)){
        var bc = col(opts.background); if(bc) root.fills = [solid(bc)];
      }
      root.name = opts.name || "Imported";
      root.x = opts.x||0; root.y = opts.y||0;
      figma.currentPage.appendChild(root);
      return { rootId: root.id, images: this._imgTasks.length, w: root.width, h: root.height };
    },
    loadImages: async function(n){
      var batch = this._imgTasks.splice(0, n);
      for(var i=0;i<batch.length;i++){
        var task = batch[i];
        try{
          var node = await figma.getNodeByIdAsync(task.id); if(!node) continue;
          var img = await figma.createImageAsync(task.url);
          var mode = task.fit==="contain"?"FIT":"FILL";
          var fills = (node.fills && node.fills.length && node.fills[0].type==="SOLID") ? node.fills.slice() : [];
          fills.push({ type:"IMAGE", scaleMode:mode, imageHash: img.hash });
          node.fills = fills;
        }catch(e){}
      }
      return this._imgTasks.length;
    },
    finalize: async function(rootId, opts){
      var node = await figma.getNodeByIdAsync(rootId); if(!node) return { error:"gone" };
      if(opts.asComponent){
        try{
          var comp = figma.createComponentFromNode(node);
          if(opts.name) comp.name = opts.name;
          figma.currentPage.selection = [comp];
          figma.viewport.scrollAndZoomIntoView([comp]);
          return { id: comp.id, type: comp.type, name: comp.name };
        }catch(e){ /* fall through to plain node */ }
      }
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);
      return { id: node.id, type: node.type, name: node.name };
    }
  };
})();
'ok'`;

/**
 * Full orchestration: extract a URL/element and rebuild it in Figma via the
 * eval bridge in short, timeout-safe steps.
 *
 * @param {object} a
 * @param {(code:string)=>Promise<any>} a.run  eval-bridge runner (daemon-backed)
 * @param {string} a.url
 * @param {string} [a.selector]  CSS selector for the target element
 * @param {string} [a.name]      name for the created frame/component
 * @param {boolean} [a.asComponent]  convert the result to a Figma component
 * @param {number} [a.x] @param {number} [a.y]  page placement
 * @param {string} [a.font]      target Figma font family (default Inter)
 * @param {number} [a.width]     Chrome viewport width (affects responsive layout)
 * @param {number} [a.batch]     images loaded per eval call
 * @param {string} [a.chromePath]
 * @param {string} [a.page]       target Figma page name (created if missing)
 * @param {boolean} [a.replace]   clear the target page before building
 * @param {(msg:string)=>void} [a.onProgress]
 */
export async function importWeb({
  run, url, selector = null, name = "Imported", asComponent = false,
  x = 0, y = 0, font = "Inter", width = 1440, batch = 4, chromePath = null,
  background = "rgb(255,255,255)", page = null, replace = false, onProgress = () => {}
}) {
  onProgress("extracting DOM from " + url);
  const { tree } = await extractDom({ url, selector, width, chromePath });

  onProgress("installing builder");
  await run(BUILDER_SRC.replace("__FONT__", font));

  onProgress("streaming tree (" + JSON.stringify(tree).length + " bytes)");
  const lit = JSON.stringify(JSON.stringify(tree));
  await run("globalThis.__cdTree = JSON.parse(" + lit + "); 'stored'");

  onProgress("building nodes");
  const built = await run(
    "await globalThis.__cd.build(" + JSON.stringify({ name, x, y, background, page, replace }) + ")"
  );

  let remaining = built.images || 0;
  while (remaining > 0) {
    onProgress("loading images (" + remaining + " left)");
    remaining = await run("await globalThis.__cd.loadImages(" + batch + ")");
  }

  onProgress(asComponent ? "converting to component" : "finalizing");
  const final = await run(
    "await globalThis.__cd.finalize(" +
      JSON.stringify(built.rootId) + "," + JSON.stringify({ asComponent, name }) + ")"
  );

  return { ...final, width: built.w, height: built.h, imageCount: built.images };
}
