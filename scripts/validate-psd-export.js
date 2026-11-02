#!/usr/bin/env node
'use strict';

/**
 * 对照 ag-psd 校验 psd-export.js 输出的关键字段（header / 图层数 / 通道 / 尺寸）。
 * 用法：node scripts/validate-psd-export.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PSD_JS = path.join(ROOT, 'app/games/collab_canvas/static/js/psd-export.js');

function loadPsdExport() {
  const code = fs.readFileSync(PSD_JS, 'utf8');
  const sandbox = {
    window: {},
    TextEncoder,
    Blob: class Blob {
      constructor(parts) {
        this._buf = Buffer.concat(parts.map(p => Buffer.from(p)));
      }
    }
  };
  vm.runInNewContext(code.replace('window', 'window'), sandbox);
  return sandbox.window.PsdExport;
}

function readU16(buf, off) {
  return (buf[off] << 8) | buf[off + 1];
}

function readU32(buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function readI16(buf, off) {
  const v = readU16(buf, off);
  return v >= 0x8000 ? v - 0x10000 : v;
}

/** 解析我们 writer 产出的 PSD 关键 header 与 layer info 字段。 */
function parsePsdHeader(buf) {
  const sig = buf.toString('ascii', 0, 4);
  if (sig !== '8BPS') throw new Error('签名应为 8BPS，实际 ' + sig);
  const version = readU16(buf, 4);
  const channels = readU16(buf, 12);
  const height = readU32(buf, 14);
  const width = readU32(buf, 18);
  const depth = readU16(buf, 22);
  const colorMode = readU16(buf, 24);
  const colorModeLen = readU32(buf, 26);
  let off = 30 + colorModeLen;
  const imageResourcesLen = readU32(buf, off);
  off += 4 + imageResourcesLen;
  const layerMaskLen = readU32(buf, off);
  off += 4;
  let layerCount = 0;
  if (layerMaskLen > 0) {
    const layerInfoSubLen = readU32(buf, off);
    if (layerInfoSubLen >= 2) {
      layerCount = Math.abs(readI16(buf, off + 4));
    }
  }
  return { version, channels, width, height, depth, colorMode, layerCount: Math.abs(layerCount) };
}

function makeTestRgba(w, h, r, g, b, a) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
  return out;
}

async function main() {
  const PsdExport = loadPsdExport();
  if (!PsdExport || typeof PsdExport.buildPsdBlob !== 'function') {
    console.error('FAIL: 无法加载 PsdExport.buildPsdBlob');
    process.exit(1);
  }

  let writePsdBuffer;
  try {
    ({ writePsdBuffer } = require('ag-psd'));
  } catch (err) {
    console.error('SKIP ag-psd 对照：请先 npm install ag-psd（' + err.message + '）');
    writePsdBuffer = null;
  }

  const w = 64;
  const h = 48;
  const bg = makeTestRgba(w, h, 255, 255, 255, 255);
  const layer1 = makeTestRgba(w, h, 200, 40, 40, 128);
  const layer2 = makeTestRgba(w, h, 40, 80, 200, 200);

  const blob = PsdExport.buildPsdBlob(bg, w, h, [
    { name: 'Background', opacity: 255, rgba: bg },
    { name: 'Paint', opacity: 200, rgba: layer1 },
    { name: 'Highlight', opacity: 255, rgba: layer2 }
  ]);
  const ours = blob._buf || Buffer.from(await blob.arrayBuffer());
  const parsed = parsePsdHeader(ours);

  const expected = { version: 1, channels: 4, width: w, height: h, depth: 8, colorMode: 3, layerCount: 3 };
  const mismatches = Object.keys(expected).filter(k => parsed[k] !== expected[k]);
  if (mismatches.length) {
    console.error('FAIL: 字段不匹配', mismatches.map(k => k + ': ' + parsed[k] + ' != ' + expected[k]));
    process.exit(1);
  }
  console.log('OK: psd-export header/layer 字段', parsed);

  if (writePsdBuffer) {
    const ref = writePsdBuffer({
      width: w,
      height: h,
      children: [
        { name: 'Background', opacity: 255, canvas: rgbaToCanvas(layer2, w, h) },
        { name: 'Paint', opacity: 200, canvas: rgbaToCanvas(layer1, w, h) },
        { name: 'Highlight', opacity: 255, canvas: rgbaToCanvas(layer2, w, h) }
      ]
    }, { invalidateTextLayers: true });
    const refParsed = parsePsdHeader(Buffer.from(ref));
    console.log('REF: ag-psd header/layer 字段', refParsed);
    if (refParsed.version !== parsed.version || refParsed.depth !== parsed.depth || refParsed.colorMode !== parsed.colorMode) {
      console.error('FAIL: 与 ag-psd 基础格式不一致');
      process.exit(1);
    }
    console.log('OK: 与 ag-psd 基础格式一致（version/depth/colorMode/channels）');
  }
}

function rgbaToCanvas(rgba, w, h) {
  const { createCanvas } = require('ag-psd/umd');
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
