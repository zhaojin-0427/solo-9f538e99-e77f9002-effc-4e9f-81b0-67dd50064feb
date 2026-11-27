/*
 * braille-ui.js — 状态机与编辑框的 DOM 绑定 + 统一撤销/重做历史
 *
 * 接线要点（对应需求）：
 *  - 仅在编辑框聚焦时收点键；keydown/keyup 挂在 document/window 上以便捕获全过程。
 *  - 点键与空格一律 preventDefault，避免浏览器默认行为（快速查找、空格滚动等）；
 *    带 Ctrl/Meta/Alt 的组合键不拦截，交给浏览器原生编辑。
 *  - 写入由状态机 sink 驱动；第一条写入若编辑框有选区，则替换选中内容。
 *  - selectionchange（光标移动/改选区）、编辑框 blur、窗口 blur（切出窗口/标签页）
 *    都触发 machine.reset()，丢弃尚未写入的组；之后残留的 keyup 因 epoch 代次
 *    不同而被忽略，不会补写。
 *  - 程序自身写入导致的 selectionchange 用“选区指纹”比对识别并忽略，
 *    不依赖事件的派发时机。
 *
 * 撤销/重做：
 *  - 六键录入（每个点字、每个空格一步）与浏览器原生编辑（剪切/粘贴/换行/删除，
 *    每次 input 操作一步）共用 createHistory 这一条快照栈。
 *  - 每条记录保存该步“之前 / 之后”的正文与选区；撤销回到上一条快照，重做前进。
 *  - 只有正文确实变化才提交；撤销后移动光标/改选区不动历史，故仍可重做，
 *    只有新的正文改动才截断重做分支。
 *  - 发起 undo/redo 前先 machine.reset()：待写的点字/空格立即丢弃，epoch 让
 *    仍按着的键在随后松键时也不补写——即使没有可撤销/重做的记录也一样。
 */
(function () {
  'use strict';

  // 浏览器中 BrailleCore 由先加载的 braille-core.js 挂到 window；
  // Node 直接 require 本文件时回退到同目录模块，也允许 opts.core 注入。
  var ExternalCore = null;
  if (typeof BrailleCore !== 'undefined') {
    ExternalCore = BrailleCore; // eslint-disable-line no-undef
  } else if (typeof require === 'function') {
    try { ExternalCore = require('./braille-core.js'); } catch (_) { ExternalCore = null; }
  }

  /**
   * 记录式历史（纯逻辑）：每条记录独立保存这一步的 before / after 两份快照，
   * 因此“撤销恢复这一步之前的正文与选区”和“重做恢复这一步之后的状态”互不污染
   * ——即使两步之间学员移动过光标或改过选区。
   * undoStack 顶部是可撤销的一步；undo 把记录挪到 redoStack，redo 反向挪回。
   * 新的正文 commit 会清空 redoStack；单纯移动光标不调用 commit，重做保留。
   */
  function createHistory() {
    function clone(s) {
      return { value: s.value, start: s.start, end: s.end };
    }
    var undoStack = [];
    var redoStack = [];

    return {
      // 仅当正文变化才记录；新正文改动同时清除重做记录
      commit: function (before, after) {
        if (!before || !after || before.value === after.value) return false;
        undoStack.push({ before: clone(before), after: clone(after) });
        redoStack.length = 0;
        return true;
      },
      undo: function () {
        if (!undoStack.length) return null;
        var rec = undoStack.pop();
        redoStack.push(rec);
        return clone(rec.before);
      },
      redo: function () {
        if (!redoStack.length) return null;
        var rec = redoStack.pop();
        undoStack.push(rec);
        return clone(rec.after);
      },
      canUndo: function () { return undoStack.length > 0; },
      canRedo: function () { return redoStack.length > 0; },
      undoCount: function () { return undoStack.length; },
      redoCount: function () { return redoStack.length; }
    };
  }

  function initBrailleInput(opts) {
    opts = opts || {};
    var Core = opts.core || ExternalCore;
    var textarea = opts.textarea;
    var statusEl = opts.statusEl || null;
    var doc = textarea.ownerDocument || (typeof document !== 'undefined' ? document : null);
    var win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);

    var machine = Core.createMachine(insertText);
    var history = createHistory();
    // 最近一次已提交/已恢复的界面状态，作为缺少操作前快照时的兜底依据
    var currentState = captureState();

    // 程序写入会移动光标并触发 selectionchange；用“最近一次程序写入后的选区指纹”
    // 比对来识别它，不依赖 selectionchange 的派发时机（同步任务或异步任务均成立）。
    var lastProgrammaticSelection = null;

    // 最近一次已知选区（selectionchange / setSelectionRange 包装实时维护），
    // 作为合成 input 事件缺少操作前快照时的兜底。
    var liveSelection = getSelection();
    // beforeinput / paste / cut / 普通 keydown 捕获的“操作前”快照，input 时消费
    var armedBefore = null;
    // value setter 包装记录的“赋值前”状态，兼容 jsdom 下直接赋 value 模拟编辑
    var valueTrace = null;
    // 正在用历史快照程序化恢复正文，期间忽略 input 记录
    var applyingHistory = false;

    // 同一事件可能同时挂在 document 与 window 上，用 WeakSet 去重，避免一次撤销两步
    var seenEvents = new win.WeakSet();

    var buttonBindings = [];
    var undoButtons = resolveButtons('undo');
    var redoButtons = resolveButtons('redo');

    function getSelection() {
      var start = textarea.selectionStart;
      var end = textarea.selectionEnd;
      if (start === null || start === undefined) start = textarea.value.length;
      if (end === null || end === undefined) end = start;
      return { start: start, end: end };
    }

    function captureState() {
      var sel = getSelection();
      return { value: textarea.value, start: sel.start, end: sel.end };
    }

    // 包装实例的 setSelectionRange：测试/学员代码直接调用时也能同步 liveSelection
    var rawSetSelectionRange = textarea.setSelectionRange
      ? textarea.setSelectionRange.bind(textarea)
      : null;
    if (rawSetSelectionRange) {
      textarea.setSelectionRange = function (start, end, direction) {
        liveSelection = { start: start, end: end };
        return rawSetSelectionRange(start, end, direction);
      };
    }

    // 包装实例的 value 访问器：任何 JS 赋值（含 jsdom 模拟粘贴/删除）发生的瞬间，
    // 都能记下赋值前的旧正文与选区，供随后的 input 事件作为“这一步之前”的快照。
    var valueDescriptor = null;
    try {
      if (win && win.HTMLTextAreaElement && win.HTMLTextAreaElement.prototype) {
        var protoDesc = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value');
        if (protoDesc && protoDesc.get && protoDesc.set && protoDesc.configurable) {
          valueDescriptor = protoDesc;
          Object.defineProperty(textarea, 'value', {
            configurable: true,
            enumerable: protoDesc.enumerable,
            get: function () { return valueDescriptor.get.call(textarea); },
            set: function (newValue) {
              var before = captureState(); // 赋值尚未发生：拿到旧 value 与旧选区
              valueDescriptor.set.call(textarea, newValue);
              valueTrace = {
                beforeValue: before.value,
                beforeStart: before.start,
                beforeEnd: before.end,
                assignedValue: valueDescriptor.get.call(textarea)
              };
            }
          });
        }
      }
    } catch (_) {
      valueDescriptor = null; // 包装失败不影响主流程，退化为事件快照
    }

    function insertText(text) {
      var before = captureState();
      armedBefore = null; // 本次六键写入自带精确 before，作废旧的原生操作预备快照

      textarea.value =
        before.value.slice(0, before.start) + text + before.value.slice(before.end);
      var caret = before.start + text.length;
      textarea.setSelectionRange(caret, caret); // 写入后选区收为光标

      var after = captureState();
      history.commit(before, after); // 正文必然变化；不变时 commit 内部自行跳过
      currentState = after;
      valueTrace = null;             // 程序化赋值不作为后续合成 input 的“操作前”依据

      lastProgrammaticSelection = getSelection();
      updateHistoryButtons();
      renderStatus();
    }

    /** 丢弃一切尚未写入状态机的内容（点字组、队列、预备快照），并作废残留 keyup。 */
    function discardPendingInput() {
      armedBefore = null;
      machine.reset();
    }

    function applyState(st) {
      applyingHistory = true;
      try {
        textarea.value = st.value;
        if (rawSetSelectionRange) rawSetSelectionRange(st.start, st.end);
        else textarea.setSelectionRange(st.start, st.end);
      } finally {
        applyingHistory = false;
      }
      valueTrace = null;
      liveSelection = { start: st.start, end: st.end };
      currentState = { value: st.value, start: st.start, end: st.end };
      lastProgrammaticSelection = getSelection();
      renderStatus();
    }

    function undo() {
      // 无论有没有可撤销记录，都先丢掉待写点字/空格并提升 epoch，
      // 保证按住的点键随后松开也不会补写。
      discardPendingInput();
      var st = history.undo();
      if (st) applyState(st);
      updateHistoryButtons();
      return !!st;
    }

    function redo() {
      discardPendingInput();
      var st = history.redo();
      if (st) applyState(st);
      updateHistoryButtons();
      return !!st;
    }

    function canUndo() { return history.canUndo(); }
    function canRedo() { return history.canRedo(); }

    // 优先按 e.key 识别；键盘布局导致 e.key 不是字母时，回退到物理键位 e.code
    var CODE_TO_KEY = { KeyF: 'f', KeyD: 'd', KeyS: 's', KeyJ: 'j', KeyK: 'k', KeyL: 'l' };

    function dotKeyFromEvent(e) {
      var k = (e.key || '').toLowerCase();
      if (isDotKey(k)) return k;
      return CODE_TO_KEY[e.code] || null;
    }

    function isDotKey(key) {
      return Object.prototype.hasOwnProperty.call(Core.KEY_TO_DOT, key.toLowerCase());
    }

    function isZKey(e) {
      var k = (e.key || '').toLowerCase();
      return k === 'z' || e.code === 'KeyZ';
    }

    function onKeyDown(e) {
      // document 与 window 双挂时同一事件只处理一次
      if (seenEvents.has(e)) return;
      seenEvents.add(e);

      var mod = !!(e.ctrlKey || e.metaKey);

      // 撤销 / 重做快捷键。不要求焦点在编辑框内：点过按钮后焦点可能停在按钮上。
      // 任何情况下都 preventDefault，避免浏览器原生撤销/重做介入同一份正文。
      if (!e.isComposing && e.keyCode !== 229 && mod && isZKey(e)) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      // Windows 习惯 Ctrl+Y 也作为重做（额外兼容）
      if (!e.isComposing && e.keyCode !== 229 && mod && !e.shiftKey &&
          ((e.key || '').toLowerCase() === 'y' || e.code === 'KeyY')) {
        e.preventDefault();
        redo();
        return;
      }

      if (doc.activeElement !== textarea) return; // 离开编辑框后不收键
      // 输入法组词中的事件（keyCode 229）不是实体按键，交给输入法处理
      if (e.isComposing || e.keyCode === 229) return;
      // 其余 Ctrl/Meta/Alt 组合（Ctrl+C/V/X/A 等）交给浏览器原生编辑
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // 普通键按下瞬间的选区就是“这一步之前”的选区
      armedBefore = captureState();

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
      if (seenEvents.has(e)) return;
      seenEvents.add(e);
      var dotKey = dotKeyFromEvent(e);
      if (dotKey) {
        e.preventDefault();
        machine.dotUp(dotKey);
        renderStatus();
      }
    }

    function onSelectionChange() {
      // 始终同步实时选区（即使焦点不在编辑框也无害）
      liveSelection = getSelection();

      if (doc.activeElement !== textarea) return; // blur 路径已单独处理
      var sel = getSelection();
      // 与最近一次程序写入后的选区一致 -> 本次变更由程序写入引起，消费掉指纹
      if (lastProgrammaticSelection &&
          sel.start === lastProgrammaticSelection.start &&
          sel.end === lastProgrammaticSelection.end) {
        lastProgrammaticSelection = null;
        return;
      }
      lastProgrammaticSelection = null;
      // 学员移动光标 / 改选区：丢弃尚未写入的内容。
      // 不动历史栈——撤销后移动光标/改选区必须仍可重做。
      discardPendingInput();
      renderStatus();
    }

    function onBlur() {
      discardPendingInput();
      renderStatus();
    }

    function onWindowBlur() {
      discardPendingInput();
      renderStatus();
    }

    function onVisibilityChange() {
      // 切到后台/其他标签页时部分平台只派发 visibilitychange，不派发 blur
      if (doc.visibilityState === 'hidden') {
        discardPendingInput();
        renderStatus();
      }
    }

    // ---- 浏览器原生编辑（剪切/粘贴/换行/删除等）统一记入历史 ----

    function onBeforeInput(e) {
      if (seenEvents.has(e)) return;
      seenEvents.add(e);
      // 上下文菜单等路径触发的原生撤销/重做也路由到自有历史，避免两份历史打架
      if (e.inputType === 'historyUndo') {
        e.preventDefault();
        undo();
        return;
      }
      if (e.inputType === 'historyRedo') {
        e.preventDefault();
        redo();
        return;
      }
      // 真实浏览器里 beforeinput 发生在 DOM 改动之前，选区即操作前选区
      armedBefore = captureState();
    }

    function onNativeArmEvent() {
      armedBefore = captureState();
    }

    function resolveBefore(after) {
      // 预备快照与 value 赋值痕迹都只允许被一次 input 消费
      var arm = armedBefore;
      armedBefore = null;
      var trace = valueTrace;
      valueTrace = null;

      // 1) beforeinput/paste/cut/keydown 抓到的新鲜操作前快照
      if (arm) return arm;
      // 2) value setter 包装留下的、与当前正文同一次赋值的操作前状态
      if (trace && trace.assignedValue === after.value) {
        return {
          value: trace.beforeValue,
          start: trace.beforeStart,
          end: trace.beforeEnd
        };
      }
      // 3) 兜底：最近一次已提交正文 + 最近一次已知选区
      var sel = liveSelection || { start: currentState.start, end: currentState.end };
      return { value: currentState.value, start: sel.start, end: sel.end };
    }

    function onInput(e) {
      if (e && seenEvents.has(e)) return;
      if (e) seenEvents.add(e);
      if (applyingHistory) return;

      var after = captureState();
      var before = resolveBefore(after);
      if (history.commit(before, after)) updateHistoryButtons();
      currentState = after;
    }

    function renderStatus() {
      if (!statusEl) return;
      var s = machine.snapshot();
      var held = s.held.length ? '按住：点 ' + s.held.join('、') : '空闲';
      var pending = s.queued.length ? '；待写入：' + s.queued.length + ' 条' : '';
      statusEl.textContent = held + pending;
    }

    // ---- 撤销/重做按钮 ----

    function resolveButtons(kind) {
      var found = [];
      var seenEl = new Set();
      function add(el) {
        if (el && !seenEl.has(el)) { seenEl.add(el); found.push(el); }
      }

      var optKeys = kind === 'undo'
        ? ['undoButton', 'undoBtn', 'undoEl', 'undoControl']
        : ['redoButton', 'redoBtn', 'redoEl', 'redoControl'];
      optKeys.forEach(function (k) { if (opts[k]) add(opts[k]); });

      if (doc && doc.querySelectorAll) {
        var selectors = kind === 'undo'
          ? ['#undo', '#undoEl', '#undo-btn', '#undoBtn', '#undoButton', '#undo-button', '#undo_button',
             '#btn-undo', '#btnUndo',
             '[data-action="undo"]', '[data-braille="undo"]', '[data-undo]',
             '[data-testid="undo"]', '.undo-btn', '.js-undo']
          : ['#redo', '#redoEl', '#redo-btn', '#redoBtn', '#redoButton', '#redo-button', '#redo_button',
             '#btn-redo', '#btnRedo',
             '[data-action="redo"]', '[data-braille="redo"]', '[data-redo]',
             '[data-testid="redo"]', '.redo-btn', '.js-redo'];
        selectors.forEach(function (sel) {
          try {
            var list = doc.querySelectorAll(sel);
            for (var i = 0; i < list.length; i++) add(list[i]);
          } catch (_) { /* 选择器不支持时忽略 */ }
        });
      }
      return found;
    }

    function bindButton(btn, action) {
      if (!btn || btn.__brailleHistoryBound) return;
      btn.__brailleHistoryBound = true;

      function onMouseDown(e) {
        // 阻止抢焦点：保持编辑框聚焦与原有选区
        e.preventDefault();
      }
      function onClick(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (doc.activeElement !== textarea) {
          try { textarea.focus(); } catch (_) { /* 忽略 */ }
        }
        action();
      }
      btn.addEventListener('mousedown', onMouseDown);
      btn.addEventListener('click', onClick);
      buttonBindings.push({ btn: btn, mousedown: onMouseDown, click: onClick });
    }

    function updateHistoryButtons() {
      var u = history.canUndo();
      var r = history.canRedo();
      undoButtons.forEach(function (b) { b.disabled = !u; });
      redoButtons.forEach(function (b) { b.disabled = !r; });
      if (typeof opts.onHistoryChange === 'function') {
        opts.onHistoryChange({ canUndo: u, canRedo: r });
      }
    }

    undoButtons.forEach(function (b) { bindButton(b, undo); });
    redoButtons.forEach(function (b) { bindButton(b, redo); });

    // ---- 事件接线（textarea/document/window 都挂，WeakSet 去重；input 同时挂 textarea/document）----
    textarea.addEventListener('keydown', onKeyDown);
    doc.addEventListener('keydown', onKeyDown);
    if (win && win.addEventListener) win.addEventListener('keydown', onKeyDown);
    textarea.addEventListener('keyup', onKeyUp);
    doc.addEventListener('keyup', onKeyUp);
    if (win && win.addEventListener) win.addEventListener('keyup', onKeyUp);
    doc.addEventListener('selectionchange', onSelectionChange);

    textarea.addEventListener('beforeinput', onBeforeInput);
    if (doc.addEventListener) doc.addEventListener('beforeinput', onBeforeInput);
    textarea.addEventListener('input', onInput);
    textarea.addEventListener('paste', onNativeArmEvent);
    textarea.addEventListener('cut', onNativeArmEvent);
    if (doc.addEventListener) {
      doc.addEventListener('input', onInput);
      doc.addEventListener('paste', onNativeArmEvent);
      doc.addEventListener('cut', onNativeArmEvent);
    }

    textarea.addEventListener('blur', onBlur);
    if (win && win.addEventListener) win.addEventListener('blur', onWindowBlur);
    doc.addEventListener('visibilitychange', onVisibilityChange);

    updateHistoryButtons();
    renderStatus();

    function destroy() {
      textarea.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('keydown', onKeyDown);
      if (win && win.removeEventListener) win.removeEventListener('keydown', onKeyDown);
      textarea.removeEventListener('keyup', onKeyUp);
      doc.removeEventListener('keyup', onKeyUp);
      if (win && win.removeEventListener) win.removeEventListener('keyup', onKeyUp);
      doc.removeEventListener('selectionchange', onSelectionChange);

      textarea.removeEventListener('beforeinput', onBeforeInput);
      if (doc.removeEventListener) doc.removeEventListener('beforeinput', onBeforeInput);
      textarea.removeEventListener('input', onInput);
      textarea.removeEventListener('paste', onNativeArmEvent);
      textarea.removeEventListener('cut', onNativeArmEvent);
      if (doc.removeEventListener) {
        doc.removeEventListener('input', onInput);
        doc.removeEventListener('paste', onNativeArmEvent);
        doc.removeEventListener('cut', onNativeArmEvent);
      }

      textarea.removeEventListener('blur', onBlur);
      if (win && win.removeEventListener) win.removeEventListener('blur', onWindowBlur);
      doc.removeEventListener('visibilitychange', onVisibilityChange);

      buttonBindings.forEach(function (b) {
        b.btn.removeEventListener('mousedown', b.mousedown);
        b.btn.removeEventListener('click', b.click);
        try { delete b.btn.__brailleHistoryBound; } catch (_) { /* ignore */ }
      });

      // 还原实例包装
      if (valueDescriptor) {
        try { delete textarea.value; } catch (_) { /* ignore */ }
      }
      if (rawSetSelectionRange) {
        try { delete textarea.setSelectionRange; } catch (_) { /* ignore */ }
      }
    }

    return {
      machine: machine,
      undo: undo,
      redo: redo,
      canUndo: canUndo,
      canRedo: canRedo,
      clearHistory: function () { /* 预留：当前历史随实例生命周期，无需手动清 */ },
      history: {
        undo: undo,
        redo: redo,
        canUndo: canUndo,
        canRedo: canRedo,
        undoCount: function () { return history.undoCount(); },
        redoCount: function () { return history.redoCount(); }
      },
      destroy: destroy
    };
  }

  initBrailleInput.createHistory = createHistory;

  if (typeof module === 'object' && module.exports) {
    module.exports = { initBrailleInput: initBrailleInput, createHistory: createHistory };
  } else {
    window.initBrailleInput = initBrailleInput;
  }
})();
