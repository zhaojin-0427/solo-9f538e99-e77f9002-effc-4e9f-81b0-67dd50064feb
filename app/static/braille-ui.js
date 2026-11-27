/*
 * braille-ui.js — 状态机与编辑框的 DOM 绑定
 *
 * 接线要点（对应需求）：
 *  - 仅在编辑框聚焦时收键；keydown/keyup 挂在 document 上以便捕获全过程。
 *  - 点键与空格一律 preventDefault，避免浏览器默认行为（快速查找、空格滚动等）。
 *  - 写入由状态机 sink 驱动；第一条写入若编辑框有选区，则替换选中内容。
 *  - selectionchange（光标移动/改选区）、编辑框 blur、窗口 blur（切出窗口/标签页）
 *    都触发 machine.reset()，丢弃尚未写入的组；之后残留的 keyup 因 epoch 代次
 *    不同而被忽略，不会补写。
 *  - 程序自身写入导致的 selectionchange 用“选区指纹”比对识别并忽略，
 *    不依赖事件的派发时机。
 */
(function () {
  'use strict';

  function initBrailleInput(opts) {
    var textarea = opts.textarea;
    var statusEl = opts.statusEl || null;
    var machine = BrailleCore.createMachine(insertText);

    // 程序写入会移动光标并触发 selectionchange；用“最近一次程序写入后的选区指纹”
    // 比对来识别它，不依赖 selectionchange 的派发时机（同步任务或异步任务均成立）。
    var lastProgrammaticSelection = null;

    function currentSelection() {
      return { start: textarea.selectionStart, end: textarea.selectionEnd };
    }

    function insertText(text) {
      var start = textarea.selectionStart;
      var end = textarea.selectionEnd;
      if (start === null || start === undefined) start = textarea.value.length;
      if (end === null || end === undefined) end = start;

      textarea.value =
        textarea.value.slice(0, start) + text + textarea.value.slice(end);
      var caret = start + text.length;
      textarea.setSelectionRange(caret, caret); // 写入后选区收为光标
      lastProgrammaticSelection = currentSelection();
      renderStatus();
    }

    // 优先按 e.key 识别；键盘布局导致 e.key 不是字母时，回退到物理键位 e.code
    var CODE_TO_KEY = { KeyF: 'f', KeyD: 'd', KeyS: 's', KeyJ: 'j', KeyK: 'k', KeyL: 'l' };

    function dotKeyFromEvent(e) {
      var k = (e.key || '').toLowerCase();
      if (isDotKey(k)) return k;
      return CODE_TO_KEY[e.code] || null;
    }

    function isDotKey(key) {
      return Object.prototype.hasOwnProperty.call(BrailleCore.KEY_TO_DOT, key.toLowerCase());
    }

    function onKeyDown(e) {
      if (document.activeElement !== textarea) return; // 离开编辑框后不收键
      // 输入法组词中的事件（keyCode 229）不是实体按键，交给输入法处理
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        machine.spaceDown(e.repeat === true);
        renderStatus();
        return;
      }
      var dotKey = dotKeyFromEvent(e);
      if (dotKey) {
        e.preventDefault();
        machine.dotDown(dotKey, e.repeat === true);
        renderStatus();
      }
    }

    function onKeyUp(e) {
      var dotKey = dotKeyFromEvent(e);
      if (dotKey) {
        e.preventDefault();
        machine.dotUp(dotKey);
        renderStatus();
      }
    }

    function onSelectionChange() {
      if (document.activeElement !== textarea) return; // blur 路径已单独处理
      var sel = currentSelection();
      // 与最近一次程序写入后的选区一致 -> 本次变更由程序写入引起，消费掉指纹
      if (lastProgrammaticSelection &&
          sel.start === lastProgrammaticSelection.start &&
          sel.end === lastProgrammaticSelection.end) {
        lastProgrammaticSelection = null;
        return;
      }
      lastProgrammaticSelection = null;
      machine.reset(); // 学员移动光标 / 改选区：丢弃尚未写入的内容
      renderStatus();
    }

    function onBlur() {
      machine.reset();
      renderStatus();
    }

    function onWindowBlur() {
      machine.reset();
      renderStatus();
    }

    function onVisibilityChange() {
      // 切到后台/其他标签页时部分平台只派发 visibilitychange，不派发 blur
      if (document.visibilityState === 'hidden') {
        machine.reset();
        renderStatus();
      }
    }

    function renderStatus() {
      if (!statusEl) return;
      var s = machine.snapshot();
      var held = s.held.length ? '按住：点 ' + s.held.join('、') : '空闲';
      var pending = s.queued.length ? '；待写入：' + s.queued.length + ' 条' : '';
      statusEl.textContent = held + pending;
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('selectionchange', onSelectionChange);
    textarea.addEventListener('blur', onBlur);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);

    renderStatus();

    return {
      machine: machine,
      destroy: function () {
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('keyup', onKeyUp);
        document.removeEventListener('selectionchange', onSelectionChange);
        textarea.removeEventListener('blur', onBlur);
        window.removeEventListener('blur', onWindowBlur);
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { initBrailleInput: initBrailleInput };
  } else {
    window.initBrailleInput = initBrailleInput;
  }
})();
