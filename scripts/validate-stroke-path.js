#!/usr/bin/env node
'use strict';

/**
 * 校验 StrokePath 纯函数：接合点去重、hasPointPath、收尾判定、512 切段。
 * 用法：node scripts/validate-stroke-path.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STROKE_PATH_JS = path.join(
  ROOT,
  'packages/ink-engine/js/board/core/stroke-path.js'
);

/** 用 vm 加载 StrokePath 到沙箱，返回全局对象。 */
function loadStrokePath() {
  const code = fs.readFileSync(STROKE_PATH_JS, 'utf8');
  const sandbox = { globalThis: {} };
  sandbox.window = sandbox.globalThis;
  vm.runInNewContext(code, sandbox);
  return sandbox.globalThis.StrokePath || sandbox.window.StrokePath;
}

/** 断言失败时抛错。 */
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** 运行全部用例。 */
function main() {
  const StrokePath = loadStrokePath();
  assert(StrokePath, 'StrokePath 未挂载');

  const joined = StrokePath.concatStrokePoints({
    segments: [
      { points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] },
      { points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }] }
    ]
  });
  assert(joined.length === 3, '接合点应去重，期望 3 点，实际 ' + joined.length);
  assert(joined[0].x === 0.1 && joined[2].x === 0.3, '接合点顺序错误');

  const legacy = {
    segments: [
      { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2, tool: 'brush' },
      { x1: 0.2, y1: 0.2, x2: 0.3, y2: 0.3, tool: 'brush' }
    ]
  };
  assert(StrokePath.hasPointPath(legacy) === false, '无 points 时应 hasPointPath=false');
  assert(
    StrokePath.hasPointPath({
      segments: [{ points: [{ x: 0, y: 0 }], x1: 0, y1: 0, x2: 0, y2: 0 }]
    }) === true,
    '有 points 时应 hasPointPath=true'
  );

  assert(
    StrokePath.isStrokeFinished({
      segments: [{ strokePart: 'mid' }, { strokePart: 'end' }]
    }) === true,
    '末段 end 应视为收尾'
  );
  assert(
    StrokePath.isStrokeFinished({
      segments: [{ strokePart: 'single' }]
    }) === true,
    'single 应视为收尾'
  );
  assert(
    StrokePath.isStrokeFinished({
      segments: [{ strokePart: 'start' }, { strokePart: 'mid' }]
    }) === false,
    'mid 不应视为收尾'
  );

  const many = [];
  for (let i = 0; i < 1025; i += 1) many.push({ x: i / 2000, y: 0 });
  const chunks = StrokePath.chunkPoints(many, 512);
  assert(chunks.length === 3, '1025 点按 512 切段应得 3 块，实际 ' + chunks.length);
  assert(chunks[0].length === 512, '首块应为 512');
  assert(chunks[1].length === 512, '次块应为 512');
  assert(chunks[2].length === 1, '末块应为 1');

  console.log('validate-stroke-path: ok');
}

main();
