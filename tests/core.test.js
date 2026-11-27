// 纯状态机测试：node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMachine, dotsToChar } = require('../app/static/braille-core.js');

function B(s) { return String.fromCharCode(0x2800 + s); }

function newMachine() {
  const out = [];
  const m = createMachine((ch) => out.push(ch));
  return { m, out };
}

test('单点与多点组合映射为正确的 Unicode 盲文字符', () => {
  assert.equal(dotsToChar([1]), B(0x01));
  assert.equal(dotsToChar([1, 2]), B(0x03));
  assert.equal(dotsToChar([1, 2, 3, 4, 5, 6]), B(0x3f));
  assert.equal(dotsToChar([]), B(0));

  const { m, out } = newMachine();
  m.dotDown('f'); m.dotUp('f');
  m.dotDown('f'); m.dotDown('d'); m.dotUp('d'); m.dotUp('f');
  m.dotDown('l'); m.dotDown('s'); m.dotUp('s'); m.dotUp('l'); // 顺序不影响掩码
  assert.deepEqual(out, [B(1), B(3), B(0x24)]); // 点3+6 = 4+32=36
});

test('长按自动重复（repeat）被忽略', () => {
  const { m, out } = newMachine();
  m.dotDown('f', false);
  for (let i = 0; i < 5; i++) m.dotDown('f', true); // 长按重复
  m.dotUp('f');
  assert.deepEqual(out, [B(1)]);

  m.spaceDown(false);
  for (let i = 0; i < 5; i++) m.spaceDown(true);
  assert.deepEqual(out, [B(1), ' ']);
});

test('首次松键即停止收键，后按的键不进当前组', () => {
  const { m, out } = newMachine();
  m.dotDown('f');          // 组A: {1}
  m.dotUp('f');            // 首次松开 -> A 停止收键且成字
  assert.deepEqual(out, [B(1)]);
  m.dotDown('d');          // 新组B: {2}
  m.dotUp('d');
  assert.deepEqual(out, [B(1), B(2)]);
});

test('组内全部松开才落字（最后一键松开前不写）', () => {
  const { m, out } = newMachine();
  m.dotDown('f'); m.dotDown('d');
  m.dotUp('d');            // 组停止收键，但 F 仍按住 -> 不落字
  assert.deepEqual(out, []);
  m.dotUp('f');
  assert.deepEqual(out, [B(3)]);
});

test('交叠按键：前组余键未松即可起下一组，各组独立成字', () => {
  const { m, out } = newMachine();
  // 组A：F+D
  m.dotDown('f'); m.dotDown('d');
  m.dotUp('d');            // A 停止收键，F 仍按住
  // 组B：J（F 还按着，不进 B）
  m.dotDown('j');
  m.dotUp('j');            // B 成字 -> ⠊（点4）
  assert.deepEqual(out, [B(0x08)]);
  m.dotUp('f');            // A 此时才全松 -> ⠃（点1,2）
  assert.deepEqual(out, [B(0x08), B(0x03)]);
});

test('空格按按下时刻与各组首键排序，不插到未就绪组前面', () => {
  const { m, out } = newMachine();
  m.dotDown('f');          // 组A 首键（seq 0）
  m.spaceDown();           // 空格（seq 1）入队；A 还没成字
  assert.deepEqual(out, [' ']); // 空格自身就绪即可先写（A 本就排在它前面但尚未就绪）
  m.dotUp('f');            // A 成字
  assert.deepEqual(out, [' ', B(1)]);

  // 反序：先按空格再按组
  const t2 = newMachine();
  t2.m.spaceDown();
  t2.m.dotDown('d'); t2.m.dotUp('d');
  assert.deepEqual(t2.out, [' ', B(2)]);
});

test('出队严格按首键顺序号（白盒：模拟就绪顺序与按下顺序不一致）', () => {
  const { m, out } = newMachine();
  // 直接构造队列：seq 大的先就绪、seq 小的后就绪，flush 仍须按 seq 输出
  const q = m._state.queue;
  q.push({ type: 'char', text: B(8), seq: 1, epoch: m._state.epoch });
  q.push({ type: 'char', text: B(3), seq: 0, epoch: m._state.epoch });
  m._state.seq = 2; // 让随后空格的 seq 大于已有条目，避免撞号
  m.spaceDown();    // 触发 flush：已有两条按 seq 排完，再写空格
  assert.deepEqual(out, [B(3), B(8), ' ']);
});

test('reset 丢弃未写入内容，之后残留 keyup 不补写', () => {
  const { m, out } = newMachine();
  m.dotDown('f'); m.dotDown('d');
  m.dotUp('d');            // 组未完成（F 按住）
  m.reset();               // 模拟移动光标/失焦/切窗
  assert.deepEqual(out, []);
  m.dotUp('f');            // 残留松开，不应补写
  assert.deepEqual(out, []);
  // reset 后状态机仍可正常录入新内容
  m.dotDown('s'); m.dotUp('s');
  assert.deepEqual(out, [B(4)]);
});

test('reset 同时清掉队列中尚未 sink 的条目', () => {
  const { m, out } = newMachine();
  m.spaceDown();
  assert.deepEqual(out, [' ']); // 空格立即 sink，队列常态为空
  m.dotDown('f');
  m.reset();
  m.dotUp('f');
  assert.deepEqual(out, [' ']); // 没有补写点1
});

test('非点键不影响状态', () => {
  const { m, out } = newMachine();
  assert.equal(m.dotDown('a'), false);
  assert.equal(m.dotUp('a'), false);
  assert.deepEqual(out, []);
});
