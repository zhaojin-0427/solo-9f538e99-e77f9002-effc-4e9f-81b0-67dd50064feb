// DOM 绑定层测试（jsdom 模拟浏览器事件）：node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const coreSrc = fs.readFileSync(path.join(__dirname, '../app/static/braille-core.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(__dirname, '../app/static/braille-ui.js'), 'utf8');

function B(s) { return String.fromCharCode(0x2800 + s); }

function setup() {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><textarea id="editor"></textarea><div id="status"></div></body></html>',
    { runScripts: 'outside-only' }
  );
  const { window } = dom;
  window.eval(coreSrc);
  window.eval(uiSrc);
  const textarea = window.document.getElementById('editor');
  const status = window.document.getElementById('status');
  const api = window.initBrailleInput({ textarea, statusEl: status });

  function fire(type, keyName, opts = {}) {
    const ev = new window.KeyboardEvent(type, {
      key: keyName, code: opts.code || 'Key' + keyName.toUpperCase(),
      repeat: !!opts.repeat, bubbles: true, cancelable: true
    });
    window.document.dispatchEvent(ev);
    return ev;
  }
  function down(keyName, repeat) { return fire('keydown', keyName, { repeat }); }
  function up(keyName) { return fire('keyup', keyName); }
  function userChangesSelection(start, end) {
    // 模拟学员用鼠标/键盘移动光标或改选区
    textarea.setSelectionRange(start, end);
    window.document.dispatchEvent(new window.Event('selectionchange'));
  }
  return { window, document: window.document, textarea, status, api, down, up, userChangesSelection };
}

test('基础落字：单键 F -> ⠁，组合 F+D -> ⠃', () => {
  const { textarea, down, up } = setup();
  textarea.focus();
  down('f'); up('f');
  assert.equal(textarea.value, B(1));

  down('f'); down('d'); up('d'); up('f');
  assert.equal(textarea.value, B(1) + B(3));
});

test('长按重复事件被忽略且 preventDefault 生效', () => {
  const { textarea, down, up } = setup();
  textarea.focus();
  down('f');
  const repeats = [1, 2, 3].map(() => down('f', true));
  up('f');
  assert.equal(textarea.value, B(1));
  assert.ok(repeats.every((ev) => ev.defaultPrevented));
});

test('交叠按键：前组余键未松即起下一组，各自独立成字', () => {
  const { textarea, down, up } = setup();
  textarea.focus();
  down('f'); down('d');
  up('d');                 // 组A 停止收键，F 仍按住，无落字
  assert.equal(textarea.value, '');
  down('j');               // 组B 开始（F 不算 B 的键）
  up('j');                 // B 全松 -> ⠊（点4）
  assert.equal(textarea.value, B(8));
  up('f');                 // A 全松 -> ⠃（点1,2）
  assert.equal(textarea.value, B(8) + B(3));
});

test('空格按按下时刻写入，组随后落字', () => {
  const { textarea, down, up } = setup();
  textarea.focus();
  down('f');               // 组按住未完成
  down(' ');               // 空格先写
  assert.equal(textarea.value, ' ');
  up('f');
  assert.equal(textarea.value, ' ' + B(1));
});

test('中途改选区：未写入的组被丢弃，残留 keyup 不补写', () => {
  const { textarea, down, up, userChangesSelection } = setup();
  textarea.focus();
  down('f'); down('d');
  up('d');                 // 组停止收键但 F 仍按住 -> 尚未落字
  assert.equal(textarea.value, '');
  userChangesSelection(0, 0); // 学员移动光标 -> reset
  up('f');                 // 残留松开，不得补写
  assert.equal(textarea.value, '');
  // 状态机仍可继续录入
  down('s'); up('s');
  assert.equal(textarea.value, B(4));
});

test('有选区时首字符替换选中内容，后续字符在新光标处插入', () => {
  const { textarea, down, up, userChangesSelection } = setup();
  textarea.focus();
  down('f'); up('f');                 // ⠁，光标在 1
  userChangesSelection(0, 1);         // 选中 ⠁
  down('j'); up('j');                 // 写入 ⠊，替换选中内容
  assert.equal(textarea.value, B(8));
  assert.equal(textarea.selectionStart, 1);
  down('k'); up('k');                 // 点5 -> ⠑，接在后面
  assert.equal(textarea.value, B(8) + B(0x10));
});

test('程序写入引起的 selectionchange 不被误判为学员操作', () => {
  const { textarea, document, window, down, up } = setup();
  textarea.focus();
  down('j'); up('j');                 // 写入 ⠊，指纹 {1,1}
  down('f');                          // 新组按住、尚未落字
  document.dispatchEvent(new window.Event('selectionchange')); // 选区仍为 {1,1}
  up('f');                            // 若被误 reset，这里不会落字
  assert.equal(textarea.value, B(8) + B(1));
});

test('离开编辑框（blur）丢弃未写入内容，残留松键不补写', () => {
  const { textarea, down, up } = setup();
  textarea.focus();
  down('f');
  textarea.blur();                    // 触发 blur -> reset
  up('f');                            // document 上仍能收到 keyup，但不补写
  assert.equal(textarea.value, '');
});

test('切出窗口（window blur）丢弃未写入内容', () => {
  const { textarea, window, down, up } = setup();
  textarea.focus();
  down('f'); down('d');
  window.dispatchEvent(new window.Event('blur'));
  up('d'); up('f');
  assert.equal(textarea.value, '');
});

test('标签页切后台（visibilitychange hidden）丢弃未写入内容', () => {
  const { textarea, document, window, down, up } = setup();
  textarea.focus();
  down('f'); down('d');
  Object.defineProperty(document, 'visibilityState', {
    configurable: true, value: 'hidden'
  });
  document.dispatchEvent(new window.Event('visibilitychange'));
  up('d'); up('f');
  assert.equal(textarea.value, '');
});

test('编辑框未聚焦时不收键', () => {
  const { textarea, down, up } = setup();
  // 不调用 focus()
  down('f'); up('f');
  assert.equal(textarea.value, '');
});

test('输入法组词事件（isComposing / keyCode 229）不被当作点键', () => {
  const { textarea, document, window } = setup();
  textarea.focus();
  const ev = new window.KeyboardEvent('keydown', {
    key: 'f', code: 'KeyF', bubbles: true, cancelable: true
  });
  Object.defineProperty(ev, 'isComposing', { configurable: true, value: true });
  document.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false, '不拦截输入法事件');
  assert.equal(textarea.value, '');
});

test('状态栏随按键状态更新', () => {
  const { status, textarea, down, up } = setup();
  textarea.focus();
  down('f');
  assert.match(status.textContent, /点 1/);
  up('f');
  assert.match(status.textContent, /空闲/);
});
