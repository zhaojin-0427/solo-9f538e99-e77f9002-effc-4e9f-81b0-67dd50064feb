// 端到端冒烟：加载经 Flask 实际提供的页面（http://127.0.0.1:8000/），
// 在真实服务的 HTML+JS 上模拟交叠按键与中途改选区两个关键场景。
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8000/';
function B(s) { return String.fromCharCode(0x2800 + s); }

test('E2E: 服务页面可加载且盲文录入端到端工作', async () => {
  const dom = await JSDOM.fromURL(BASE, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true
  });
  const { window } = dom;
  await new Promise((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
  });
  // 等待外部脚本执行
  await new Promise((r) => setTimeout(r, 200));

  const ta = window.document.getElementById('editor');
  assert.ok(ta, '练习编辑框存在');
  assert.equal(typeof window.initBrailleInput, 'function', 'UI 脚本已加载');
  assert.equal(typeof window.BrailleCore, 'object', '核心脚本已加载');
  // 对照表由脚本生成
  assert.ok(window.document.getElementById('chart').textContent.includes('⠁'));

  ta.focus();
  function fire(type, keyName, repeat) {
    window.document.dispatchEvent(new window.KeyboardEvent(type, {
      key: keyName, code: 'Key' + keyName.toUpperCase(),
      repeat: !!repeat, bubbles: true, cancelable: true
    }));
  }

  // 场景一：交叠按键（F+D 组未全松即起 J 组）
  fire('keydown', 'f'); fire('keydown', 'd');
  fire('keyup', 'd');
  fire('keydown', 'j'); fire('keyup', 'j');
  assert.equal(ta.value, B(8), 'J 组先成字 ⠊');
  fire('keyup', 'f');
  assert.equal(ta.value, B(8) + B(3), 'F+D 组成字 ⠃，按下首键顺序保留');

  // 场景二：中途改选区，未写入内容丢弃且残留松键不补写
  fire('keydown', 'f'); fire('keydown', 's');
  fire('keyup', 's');                 // 组停止收键，F 仍按住
  ta.setSelectionRange(0, 0);
  window.document.dispatchEvent(new window.Event('selectionchange'));
  fire('keyup', 'f');                 // 残留松开，不补写
  assert.equal(ta.value, B(8) + B(3), '无新字符写入');

  // 空格（先把光标移回末尾，模拟学员重新定位后继续录入）
  ta.setSelectionRange(ta.value.length, ta.value.length);
  fire('keydown', ' ');
  assert.equal(ta.value, B(8) + B(3) + ' ');

  window.close();
});
