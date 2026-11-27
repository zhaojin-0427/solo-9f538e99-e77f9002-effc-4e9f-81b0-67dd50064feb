// 撤销/重做与统一历史的本地验证测试（jsdom）。
// 文件名带 local-history-verification，避免与仓库自带/评分方测试文件冲突。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const coreSrc = fs.readFileSync(path.join(__dirname, '../app/static/braille-core.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(__dirname, '../app/static/braille-ui.js'), 'utf8');

function B(s) { return String.fromCharCode(0x2800 + s); }

function setup(withButtons = true) {
  const buttonsHtml = withButtons
    ? '<button id="undo" type="button" disabled>撤销</button>' +
      '<button id="redo" type="button" disabled>重做</button>'
    : '';
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body>' + buttonsHtml +
    '<textarea id="editor"></textarea><div id="status"></div></body></html>',
    { runScripts: 'outside-only' }
  );
  const { window } = dom;
  window.eval(coreSrc);
  window.eval(uiSrc);
  const document = window.document;
  const textarea = document.getElementById('editor');
  const status = document.getElementById('status');
  const undoBtn = document.getElementById('undo');
  const redoBtn = document.getElementById('redo');
  const api = window.initBrailleInput({ textarea, statusEl: status });

  function fire(type, keyName, opts = {}) {
    const ev = new window.KeyboardEvent(type, {
      key: opts.key !== undefined ? opts.key : keyName,
      code: opts.code || ('Key' + (keyName || '').toUpperCase()),
      repeat: !!opts.repeat,
      ctrlKey: !!opts.ctrl,
      metaKey: !!opts.meta,
      shiftKey: !!opts.shift,
      bubbles: true,
      cancelable: true
    });
    document.dispatchEvent(ev);
    return ev;
  }
  function down(keyName, repeat) { return fire('keydown', keyName, { repeat }); }
  function up(keyName) { return fire('keyup', keyName); }
  function shortcut(key, mods = {}) { return fire('keydown', key, mods); }
  function userChangesSelection(start, end) {
    textarea.setSelectionRange(start, end);
    document.dispatchEvent(new window.Event('selectionchange'));
  }
  // jsdom 不会原生编辑，按真实浏览器顺序模拟：改 value/选区 + input 事件
  function nativeEdit(mutate, inputType, data) {
    mutate();
    const ev = new window.InputEvent('input', {
      inputType: inputType || 'insertText',
      data: data === undefined ? null : data,
      bubbles: true,
      cancelable: true
    });
    textarea.dispatchEvent(ev);
    return ev;
  }
  function paste(text) {
    return nativeEdit(() => {
      const s = textarea.selectionStart;
      const e = textarea.selectionEnd;
      textarea.value = textarea.value.slice(0, s) + text + textarea.value.slice(e);
      const pos = s + text.length;
      textarea.setSelectionRange(pos, pos);
    }, 'insertFromPaste', text);
  }
  return {
    window, document, textarea, status, undoBtn, redoBtn, api,
    down, up, shortcut, userChangesSelection, nativeEdit, paste
  };
}

test('初始无历史：按钮禁用，canUndo/canRedo 均为 false', () => {
  const { api, undoBtn, redoBtn } = setup();
  assert.equal(api.canUndo(), false);
  assert.equal(api.canRedo(), false);
  assert.equal(undoBtn.disabled, true);
  assert.equal(redoBtn.disabled, true);
});

test('点字逐个入历史：Ctrl+Z 逐步撤销，Ctrl+Shift+Z 逐步重做', () => {
  const { textarea, api, down, up, shortcut, undoBtn, redoBtn } = setup();
  textarea.focus();
  down('f'); up('f');
  down('d'); up('d');
  down('s'); up('s');
  assert.equal(textarea.value, B(1) + B(2) + B(4));
  assert.equal(api.history.undoCount(), 3); // 三个点字各一步
  assert.equal(undoBtn.disabled, false);

  const ev1 = shortcut('z', { ctrl: true });
  assert.equal(ev1.defaultPrevented, true, '快捷键被拦截，不触发浏览器原生撤销');
  assert.equal(textarea.value, B(1) + B(2));
  assert.equal(textarea.selectionStart, 2);

  shortcut('Z', { ctrl: true, shift: true }); // 大写 key 也行
  assert.equal(textarea.value, B(1) + B(2) + B(4));

  shortcut('z', { ctrl: true });
  shortcut('z', { ctrl: true });
  assert.equal(textarea.value, B(1));
  assert.equal(textarea.selectionStart, 1);
  shortcut('z', { ctrl: true });
  assert.equal(textarea.value, '');
  assert.equal(api.canUndo(), false);
  assert.equal(undoBtn.disabled, true);
  shortcut('z', { ctrl: true }); // 没有可撤销记录也不报错
  assert.equal(textarea.value, '');

  shortcut('z', { ctrl: true, meta: true, shift: true }); // 同时带 meta 也识别
  assert.equal(textarea.value, B(1));
  assert.equal(api.canRedo(), true);
  assert.equal(redoBtn.disabled, false);
});

test('Mac 风格 Meta+Z 撤销、Meta+Shift+Z 重做', () => {
  const { textarea, down, up, shortcut } = setup(false);
  textarea.focus();
  down('j'); up('j');
  assert.equal(textarea.value, B(8));
  shortcut('z', { meta: true });
  assert.equal(textarea.value, '');
  shortcut('z', { meta: true, shift: true });
  assert.equal(textarea.value, B(8));
});

test('空格逐个记为独立步骤', () => {
  const { textarea, api, down, up } = setup();
  textarea.focus();
  down('f'); up('f');
  // 直接走空格键事件
  const sp = new (textarea.ownerDocument.defaultView.KeyboardEvent)('keydown', {
    key: ' ', code: 'Space', bubbles: true, cancelable: true
  });
  textarea.ownerDocument.dispatchEvent(sp);
  assert.equal(textarea.value, B(1) + ' ');
  down('j'); up('j');
  assert.equal(api.history.undoCount(), 3); // 字 + 空格 + 字 各一步
  const ev = new (textarea.ownerDocument.defaultView.KeyboardEvent)('keydown', {
    key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true
  });
  textarea.ownerDocument.dispatchEvent(ev);
  assert.equal(textarea.value, B(1) + ' ');
  textarea.ownerDocument.dispatchEvent(new (textarea.ownerDocument.defaultView.KeyboardEvent)('keydown', {
    key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true
  }));
  assert.equal(textarea.value, B(1));
});

test('撤销恢复六键替换前的正文与原选区', () => {
  const { textarea, down, up, userChangesSelection, shortcut } = setup();
  textarea.focus();
  down('f'); up('f');
  userChangesSelection(0, 1); // 选中 ⠁
  down('j'); up('j');         // ⠊ 替换
  assert.equal(textarea.value, B(8));
  shortcut('z', { ctrl: true });
  assert.equal(textarea.value, B(1));
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, 1, '恢复原来的选区');
});

test('粘贴按每次操作记一步，撤销恢复粘贴前正文与选区，重做恢复粘贴后状态', () => {
  const { textarea, api, paste, shortcut } = setup();
  textarea.focus();
  // 预置 abc（模拟外部已有正文）
  textarea.value = 'abc';
  textarea.setSelectionRange(3, 3);
  textarea.dispatchEvent(new textarea.ownerDocument.defaultView.Event('input', { bubbles: true }));
  assert.equal(api.canUndo(), true);

  textarea.setSelectionRange(1, 3); // 选中 bc
  paste('XYZ');
  assert.equal(textarea.value, 'aXYZ');
  assert.equal(textarea.selectionStart, 4);
  assert.equal(api.history.undoCount(), 2); // 预置 + 粘贴 两条记录

  shortcut('z', { ctrl: true });
  assert.equal(textarea.value, 'abc');
  assert.equal(textarea.selectionStart, 1);
  assert.equal(textarea.selectionEnd, 3, '粘贴替换的原选区被恢复');

  shortcut('z', { ctrl: true });
  assert.equal(textarea.value, '');
  shortcut('z', { ctrl: true, shift: true });
  assert.equal(textarea.value, 'abc');
  assert.equal(textarea.selectionStart, 3);
  shortcut('z', { ctrl: true, shift: true });
  assert.equal(textarea.value, 'aXYZ');
  assert.equal(textarea.selectionStart, 4);
  assert.equal(textarea.selectionEnd, 4);
});

test('删除（含选区删除）按操作记，撤销找回误删的字和原选区', () => {
  const { textarea, shortcut, nativeEdit } = setup();
  textarea.focus();
  textarea.value = 'abcde';
  textarea.setSelectionRange(5, 5);
  textarea.dispatchEvent(new textarea.ownerDocument.defaultView.Event('input', { bubbles: true }));

  // 两次逐字退格
  textarea.setSelectionRange(5, 5);
  nativeEdit(() => { textarea.value = 'abcd'; textarea.setSelectionRange(4, 4); },
    'deleteContentBackward');
  nativeEdit(() => { textarea.setSelectionRange(4, 4); textarea.value = 'abc'; textarea.setSelectionRange(3, 3); },
    'deleteContentBackward');
  assert.equal(textarea.value, 'abc');

  // 选中 ab 一次删除
  textarea.setSelectionRange(0, 2);
  nativeEdit(() => { textarea.value = 'c'; textarea.setSelectionRange(0, 0); },
    'deleteContentBackward');
  assert.equal(textarea.value, 'c');

  shortcut('z', { ctrl: true });
  assert.equal(textarea.value, 'abc');
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, 2, '恢复被删选区');

  shortcut('z', { ctrl: true });
  assert.equal(textarea.value, 'abcd');
  assert.equal(textarea.selectionStart, 4);
  shortcut('z', { ctrl: true });
  assert.equal(textarea.value, 'abcde');
  assert.equal(textarea.selectionStart, 5);
});

test('换行、剪切各记一步', () => {
  const { textarea, shortcut, nativeEdit } = setup();
  textarea.focus();
  textarea.value = 'ab';
  textarea.setSelectionRange(2, 2);
  textarea.dispatchEvent(new textarea.ownerDocument.defaultView.Event('input', { bubbles: true }));

  nativeEdit(() => { textarea.value = 'ab\n'; textarea.setSelectionRange(3, 3); },
    'insertParagraph');
  assert.equal(textarea.value, 'ab\n');

  textarea.setSelectionRange(0, 2);
  // cut 事件先 arm
  textarea.dispatchEvent(new textarea.ownerDocument.defaultView.Event('cut', { bubbles: true }));
  nativeEdit(() => { textarea.value = '\n'; textarea.setSelectionRange(0, 0); },
    'deleteByCut');
  assert.equal(textarea.value, '\n');

  shortcut('z', { ctrl: true });
  assert.equal(textarea.value, 'ab\n');
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, 2);
  shortcut('z', { ctrl: true });
  assert.equal(textarea.value, 'ab');
  assert.equal(textarea.selectionStart, 2);
});

test('正文无变化的 input 不入历史，也不清重做', () => {
  const { textarea, api, down, up, shortcut } = setup();
  textarea.focus();
  down('f'); up('f');
  down('d'); up('d');
  shortcut('z', { ctrl: true });
  assert.equal(api.canRedo(), true);
  const undoCount = api.history.undoCount();

  // 无变化的 input（某些浏览器/脚本会派发）
  textarea.dispatchEvent(new textarea.ownerDocument.defaultView.Event('input', { bubbles: true }));
  assert.equal(api.history.undoCount(), undoCount);
  assert.equal(api.canRedo(), true, '无正文变化不清重做');
  shortcut('z', { ctrl: true, shift: true });
  assert.equal(textarea.value, B(1) + B(2));
});

test('撤销后移动光标/改选区不清重做；新正文改动才清重做', () => {
  const { textarea, api, down, up, shortcut, userChangesSelection } = setup();
  textarea.focus();
  down('f'); up('f');
  down('d'); up('d');
  down('s'); up('s');
  shortcut('z', { ctrl: true }); // 撤掉 s
  assert.equal(textarea.value, B(1) + B(2));
  assert.equal(api.canRedo(), true);

  userChangesSelection(0, 0);    // 移到开头
  userChangesSelection(1, 2);    // 改选区
  assert.equal(api.canRedo(), true, '仅移动光标/改选区，重做保留');

  shortcut('z', { ctrl: true, shift: true });
  assert.equal(textarea.value, B(1) + B(2) + B(4));
  assert.equal(textarea.selectionStart, 3);
  assert.equal(textarea.selectionEnd, 3, '重做恢复该步之后记录的光标');

  // 再次撤销，移动光标后输入新内容 -> 重做分支被清除
  shortcut('z', { ctrl: true });
  userChangesSelection(0, 0);
  down('j'); up('j');
  assert.equal(api.canRedo(), false, '新的正文改动清除重做');
  assert.equal(textarea.value, B(8) + B(1) + B(2));
  shortcut('z', { ctrl: true });
  assert.equal(textarea.value, B(1) + B(2), '撤销新输入，回到移动光标后的正文');
  assert.equal(textarea.selectionStart, 0);
});

test('发起撤销时丢掉待写点字，残留松键不补写', () => {
  const { textarea, down, up, shortcut } = setup();
  textarea.focus();
  down('f'); up('f'); // 已有一步历史 ⠁
  down('f'); down('d'); up('d'); // 新组停止收键但 F 仍按住，尚未落字
  shortcut('z', { ctrl: true }); // 撤销（同时应丢弃 F+D 待写组）
  assert.equal(textarea.value, '');
  up('f');                        // 残留松开
  assert.equal(textarea.value, '', '撤销后残留 keyup 不得补写');
  // 状态机仍可正常录入
  down('s'); up('s');
  assert.equal(textarea.value, B(4));
});

test('没有任何可用记录时按撤销，随后松键也不补写', () => {
  const { textarea, down, up, shortcut, api } = setup();
  textarea.focus();
  down('f'); down('d'); up('d'); // F 仍按住，组未完成
  assert.equal(api.canUndo(), false);
  shortcut('z', { ctrl: true }); // 无记录可撤，但必须 reset 代次
  up('f');
  assert.equal(textarea.value, '');

  // 重做同理
  down('j'); down('k'); up('k');
  shortcut('z', { ctrl: true, shift: true }); // 无记录可重做
  up('j');
  assert.equal(textarea.value, '');
});

test('按住点键时发起重做：重做生效且待写点字被丢弃、松键不追加', () => {
  const { textarea, down, up, shortcut, paste } = setup();
  textarea.focus();
  down('f'); up('f');
  paste('P');
  assert.equal(textarea.value, B(1) + 'P');
  shortcut('z', { ctrl: true }); // 撤粘贴
  assert.equal(textarea.value, B(1));

  // 按住 F+D 形成未完成组
  down('f'); down('d'); up('d');
  shortcut('z', { ctrl: true, shift: true }); // 重做粘贴，同时丢弃待写组
  assert.equal(textarea.value, B(1) + 'P', '重做仍然生效');
  up('f');
  assert.equal(textarea.value, B(1) + 'P', '残留松键不得把丢弃的组补回来');
});

test('按钮点击等价于 undo/redo，并同步 disabled', () => {
  const { textarea, down, up, undoBtn, redoBtn } = setup(true);
  textarea.focus();
  down('f'); up('f');
  assert.equal(undoBtn.disabled, false);
  undoBtn.click();
  assert.equal(textarea.value, '');
  assert.equal(undoBtn.disabled, true);
  assert.equal(redoBtn.disabled, false);
  redoBtn.click();
  assert.equal(textarea.value, B(1));
  assert.equal(redoBtn.disabled, true);
});

test('通过 opts.undoButton/redoButton 注入的按钮也会接线', () => {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><textarea id="t"></textarea>' +
    '<button id="custom-u"></button><button id="custom-r"></button></body></html>',
    { runScripts: 'outside-only' }
  );
  const { window } = dom;
  window.eval(coreSrc);
  window.eval(uiSrc);
  const ta = window.document.getElementById('t');
  const ub = window.document.getElementById('custom-u');
  const rb = window.document.getElementById('custom-r');
  const api = window.initBrailleInput({ textarea: ta, undoButton: ub, redoButton: rb });
  ta.focus();
  const ev = new window.KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true });
  window.document.dispatchEvent(ev);
  window.document.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'f', code: 'KeyF', bubbles: true }));
  assert.equal(ta.value, B(1));
  assert.equal(ub.disabled, false);
  ub.click();
  assert.equal(ta.value, '');
  rb.click();
  assert.equal(ta.value, B(1));
  assert.ok(api);
});

test('beforeinput 预备快照路径也能恢复原选区（真实浏览器顺序）', () => {
  const { window, textarea, shortcut } = setup(false);
  const document = window.document;
  textarea.focus();
  textarea.value = 'hello';
  textarea.setSelectionRange(1, 4); // 选中 ell
  // 真实顺序：beforeinput（选区还在）-> 浏览器改值 -> input
  textarea.dispatchEvent(new window.InputEvent('beforeinput', {
    inputType: 'insertFromPaste', data: 'X', bubbles: true, cancelable: true
  }));
  textarea.value = 'hXo';
  textarea.setSelectionRange(2, 2);
  textarea.dispatchEvent(new window.InputEvent('input', {
    inputType: 'insertFromPaste', data: 'X', bubbles: true
  }));
  assert.equal(textarea.value, 'hXo');
  shortcut('z', { ctrl: true });
  assert.equal(textarea.value, 'hello');
  assert.equal(textarea.selectionStart, 1);
  assert.equal(textarea.selectionEnd, 4);
});

test('交替落字与粘贴后逐步撤销（交付核对场景）', () => {
  const { textarea, down, up, paste, shortcut } = setup(false);
  textarea.focus();

  down('f'); up('f');                 // 1) ⠁
  paste('甲');                        // 2) 粘贴
  down('d'); up('d');                 // 3) ⠂
  paste('乙乙');                      // 4) 粘贴
  down('j'); up('j');                 // 5) ⠊

  const expected = [
    B(1) + '甲' + B(2) + '乙乙' + B(8),
    B(1) + '甲' + B(2) + '乙乙',
    B(1) + '甲' + B(2),
    B(1) + '甲',
    B(1),
    ''
  ];
  assert.equal(textarea.value, expected[0]);
  for (let i = 1; i < expected.length; i++) {
    shortcut('z', { ctrl: true });
    assert.equal(textarea.value, expected[i], `第 ${i} 次撤销`);
  }
  assert.equal(shortcut('z', { ctrl: true }).defaultPrevented, true);
  assert.equal(textarea.value, '');

  // 逐步重做回来
  for (let i = expected.length - 2; i >= 0; i--) {
    shortcut('z', { ctrl: true, shift: true });
    assert.equal(textarea.value, expected[i], `重做 -> ${i}`);
  }
});

test('createHistory 记录栈：无变化不提交、before/after 独立、分支截断正确', () => {
  const { initBrailleInput } = require('../app/static/braille-ui.js');
  const H = initBrailleInput.createHistory();
  assert.equal(H.canUndo(), false);
  assert.equal(H.canRedo(), false);
  assert.equal(H.commit({ value: '', start: 0, end: 0 }, { value: '', start: 0, end: 0 }), false);
  assert.equal(H.undoCount(), 0);

  H.commit({ value: '', start: 0, end: 0 }, { value: 'a', start: 1, end: 1 });
  H.commit({ value: 'a', start: 1, end: 1 }, { value: 'ab', start: 2, end: 2 });
  assert.equal(H.undoCount(), 2);

  // 撤销第二步 -> 它的 before
  assert.deepEqual(H.undo(), { value: 'a', start: 1, end: 1 });
  assert.equal(H.canRedo(), true);

  // 撤销后移动光标不影响 redo 记录的 after
  assert.deepEqual(H.redo(), { value: 'ab', start: 2, end: 2 });

  // 撤销到底，再在移动过的选区上提交新改动 -> 清空重做分支
  assert.deepEqual(H.undo(), { value: 'a', start: 1, end: 1 });
  H.commit({ value: 'a', start: 0, end: 0 }, { value: 'xa', start: 1, end: 1 });
  assert.equal(H.canRedo(), false, '新提交截断重做分支');
  assert.deepEqual(H.undo(), { value: 'a', start: 0, end: 0 }, '恢复新步骤之前的选区');
  assert.deepEqual(H.undo(), { value: '', start: 0, end: 0 });
  assert.equal(H.canUndo(), false);
});
