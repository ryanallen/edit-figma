/**
 * 🦞 ClawDaddy Web Export (Figma → tree JSON)
 *
 * The reverse of webimport: walk a Figma node into a JSON tree of geometry +
 * paint/stroke/effect/text properties, exporting any node that can't be
 * reproduced with CSS (image fills, vectors/icons) as a PNG asset. A codegen
 * step (in the consumer) turns that tree into markup — e.g. React stories.
 *
 * Runs over the same eval bridge as webimport, in short steps: install the
 * walker, export the tree (fast, no bitmaps), then drain image bytes one node
 * at a time (each a separate eval, chunked base64) so nothing hits the 25s cap.
 */
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// Installed once as globalThis.__cdx. Plugin API only; async node getter +
// loadAllPagesAsync for dynamic-page. No template literals / ${} inside.
export const EXPORTER_SRC = `
globalThis.__cdx = (function(){
  function hex(c){ return "rgba("+Math.round((c.r||0)*255)+","+Math.round((c.g||0)*255)+","+Math.round((c.b||0)*255)+","+(c.a==null?1:c.a)+")"; }
  function solidFill(fills){
    if(!fills || fills===figma.mixed) return null;
    for(var i=0;i<fills.length;i++){ var f=fills[i]; if(f.visible!==false && f.type==="SOLID"){ var o=(f.opacity==null?1:f.opacity); return hex({r:f.color.r,g:f.color.g,b:f.color.b,a:o}); } }
    return null;
  }
  function hasImage(node){
    var f = node.fills;
    if(!f || f===figma.mixed) return false;
    for(var i=0;i<f.length;i++){ if(f[i].type==="IMAGE" && f[i].visible!==false) return true; }
    return false;
  }
  var VECTORY = { VECTOR:1, BOOLEAN_OPERATION:1, STAR:1, POLYGON:1, LINE:1, ELLIPSE:1 };
  function shadowCss(effects){
    if(!effects) return null;
    var out=[];
    for(var i=0;i<effects.length;i++){ var e=effects[i]; if(e.visible!==false && (e.type==="DROP_SHADOW")){ out.push((e.offset?e.offset.x:0)+"px "+(e.offset?e.offset.y:0)+"px "+(e.radius||0)+"px "+(e.spread||0)+"px "+hex({r:e.color.r,g:e.color.g,b:e.color.b,a:e.color.a})); } }
    return out.length?out.join(", "):null;
  }
  function radii(node){
    if(typeof node.cornerRadius === "number" && node.cornerRadius) return [node.cornerRadius,node.cornerRadius,node.cornerRadius,node.cornerRadius];
    var tl=node.topLeftRadius||0, tr=node.topRightRadius||0, br=node.bottomRightRadius||0, bl=node.bottomLeftRadius||0;
    return (tl||tr||br||bl)?[tl,tr,br,bl]:null;
  }
  var imgQueue = [];
  function walk(node, root){
    var abb = node.absoluteBoundingBox; if(!abb) return null;
    var rb = root.absoluteBoundingBox;
    var o = { name:node.name, type:node.type,
      x: Math.round((abb.x - rb.x)*100)/100, y: Math.round((abb.y - rb.y)*100)/100,
      w: Math.round(abb.width*100)/100, h: Math.round(abb.height*100)/100,
      opacity: (node.opacity==null?1:node.opacity) };
    var bg = solidFill(node.fills); if(bg) o.bg = bg;
    var st = solidFill(node.strokes); if(st){ o.border = st; o.borderWidth = (typeof node.strokeWeight==="number"?node.strokeWeight:1); }
    var r = radii(node); if(r) o.radius = r;
    var sh = shadowCss(node.effects); if(sh) o.shadow = sh;
    if(node.type==="TEXT"){
      o.text = node.characters;
      o.fontSize = (typeof node.fontSize==="number"?node.fontSize:16);
      var fn = node.fontName; if(fn && fn!==figma.mixed){ o.fontFamily = fn.family; o.fontStyle = fn.style; }
      var tc = solidFill(node.fills); if(tc) o.color = tc;
      o.align = node.textAlignHorizontal;
      if(node.lineHeight && node.lineHeight.unit==="PIXELS") o.lineHeight = node.lineHeight.value;
      if(node.letterSpacing && node.letterSpacing.unit==="PIXELS") o.letterSpacing = node.letterSpacing.value;
      return o;
    }
    if(hasImage(node) || VECTORY[node.type]){ o.render = "image"; o.id = node.id; imgQueue.push(node.id); return o; }
    if("children" in node && node.children && node.children.length){
      o.children = [];
      for(var i=0;i<node.children.length;i++){ if(node.children[i].visible===false) continue; var c = walk(node.children[i], root); if(c) o.children.push(c); }
    }
    return o;
  }
  function b64(bytes){ var bin=""; var CH=32768; for(var i=0;i<bytes.length;i+=CH) bin+=String.fromCharCode.apply(null, bytes.subarray(i,i+CH)); return btoa(bin); }
  return {
    listPages: async function(){
      await figma.loadAllPagesAsync();
      return figma.root.children.map(function(p){
        return { id:p.id, name:p.name, children: p.children.map(function(c){ return { id:c.id, name:c.name, type:c.type }; }) };
      });
    },
    exportTree: async function(rootId){
      await figma.loadAllPagesAsync();
      var node = await figma.getNodeByIdAsync(rootId);
      if(!node) throw new Error("node not found: "+rootId);
      imgQueue = [];
      var tree = walk(node, node);
      globalThis.__cdxQueue = imgQueue.slice();
      return { tree: tree, images: imgQueue.length };
    },
    nextImage: async function(scale){
      var q = globalThis.__cdxQueue || [];
      if(!q.length) return null;
      var id = q.shift(); globalThis.__cdxQueue = q;
      var node = await figma.getNodeByIdAsync(id);
      if(!node || !node.exportAsync) return { id:id, data:null, remaining:q.length };
      var bytes = await node.exportAsync({ format:"PNG", constraint:{ type:"SCALE", value: scale||2 } });
      return { id:id, data: b64(bytes), remaining: q.length };
    }
  };
})();
'ok'`;

/** Enumerate Figma pages and their top-level children. */
export async function listPages({ run }) {
  await run(EXPORTER_SRC);
  return run("await globalThis.__cdx.listPages()");
}

/**
 * Export one Figma node into a JSON tree, writing image/vector leaves as PNGs.
 * @returns {Promise<{tree:object, assets:Record<string,string>}>}
 *   assets maps a node id → PNG filename written under assetsDir.
 */
export async function exportNodeTree({ run, nodeId, assetsDir, scale = 2, onProgress = () => {} }) {
  await run(EXPORTER_SRC);
  onProgress("walking node " + nodeId);
  const res = await run("await globalThis.__cdx.exportTree(" + JSON.stringify(nodeId) + ")");
  const assets = {};
  let remaining = res.images || 0;
  if (remaining > 0 && assetsDir) mkdirSync(assetsDir, { recursive: true });
  while (remaining > 0) {
    onProgress("exporting images (" + remaining + " left)");
    const img = await run("await globalThis.__cdx.nextImage(" + scale + ")");
    if (!img) break;
    remaining = img.remaining;
    if (img.data && assetsDir) {
      const file = img.id.replace(/[^a-zA-Z0-9_-]/g, "_") + ".png";
      writeFileSync(join(assetsDir, file), Buffer.from(img.data, "base64"));
      assets[img.id] = file;
    }
  }
  return { tree: res.tree, assets };
}
