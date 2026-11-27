/*
 * braille-core.js — 六键盲文录入状态机（纯逻辑，不依赖 DOM）
 *
 * 规则：
 *  - F D S J K L 依次对应盲文第 1~6 点，一组键的组合映射为一个 Unicode 盲文字符。
 *  - 长按产生的重复 keydown（event.repeat）一律忽略。
 *  - 一组点键在“首次松开其中一键”后即停止收键；其余键尚未松开也可以开始下一组
 *    （允许组与组交叠）。
 *  - 一组内的键全部松开后，该组才“成字”入队。
 *  - 点字与词间空格按“各组首键 / 空格键”的按下顺序写入；空格永远排在按下时
 *    尚未成字的各组之后。
 *  - 出队写入时若编辑框存在选区，第一条写入的字符替换选中内容。
 *  - 学员移动光标、改选区、离开编辑框或切出窗口时，丢弃所有尚未写入的内容，
 *    之后到来的松开事件也不补写（用 epoch 代次隔离）。
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    global.BrailleCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 键位 -> 点号（F D S J K L = 1 2 3 4 5 6）
  var KEY_TO_DOT = { f: 1, d: 2, s: 3, j: 4, k: 5, l: 6 };

  // Unicode 盲文模式：U+2800，点 n 对应位 2^(n-1)
  var BRAILLE_BASE = 0x2800;

  function dotBit(dot) {
    return 1 << (dot - 1);
  }

  function dotsToChar(dots) {
    var mask = 0;
    for (var i = 0; i < dots.length; i++) mask |= dotBit(dots[i]);
    return String.fromCharCode(BRAILLE_BASE + mask);
  }

  /**
   * 创建状态机。
   * @param {function(string): void} sink  成字/空格出队写入回调，按序逐条调用
   */
  function createMachine(sink) {
    var state = {
      // 当前正在收键的组；首次松键后置 null（停止收键），键未全松前可起下一组
      collecting: null,
      // 已停止收键、但仍有键处于按下状态的组（等待全部松开后成字）
      finishing: [],
      // 已就绪、等待按序写入的条目：{type:'char'|'space', text, seq, epoch}
      queue: [],
      // 当前物理按下的点号集合（跨组，仅用于判定某组是否全部松开）
      heldDots: {},
      // 条目全局顺序号 = “首键/空格键按下顺序”
      seq: 0,
      // 代次：reset 后 ++，旧代次的事件全部作废
      epoch: 0
    };

    function flush() {
      // 条目就绪顺序可能不同于首键顺序（例如空格先入队、组后成字），
      // 每次都取当前代次中顺序号最小的条目，保证严格按下顺序写入。
      while (state.queue.length) {
        var idx = -1;
        for (var i = 0; i < state.queue.length; i++) {
          if (state.queue[i].epoch !== state.epoch) continue;
          if (idx === -1 || state.queue[i].seq < state.queue[idx].seq) idx = i;
        }
        if (idx === -1) {
          state.queue.length = 0; // 只剩已作废代次的条目
          return;
        }
        var entry = state.queue.splice(idx, 1)[0];
        sink(entry.text);
      }
    }

    /** 点键按下。repeat=true（长按自动重复）时忽略。返回是否被处理。 */
    function dotDown(key, repeat) {
      var dot = KEY_TO_DOT[key.toLowerCase()];
      if (!dot) return false;
      if (repeat) return true; // 长按重复：吞掉但不产生任何状态变化

      // reset 之后仍按着的旧键，其 keyup 已按旧代次隔离；这里同样只认真实新按下
      if (Object.prototype.hasOwnProperty.call(state.heldDots, dot)) {
        return true; // 去重，理论上 repeat 已挡住
      }
      state.heldDots[dot] = state.epoch;

      if (!state.collecting) {
        // 开始新一组（前一组可能还有键没松，允许交叠）
        state.collecting = {
          dots: {},
          mask: 0,
          seq: state.seq++,
          epoch: state.epoch
        };
      }
      var g = state.collecting;
      if (!Object.prototype.hasOwnProperty.call(g.dots, dot)) {
        g.dots[dot] = true;
        g.mask |= dotBit(dot);
      }
      return true;
    }

    /** 点键松开。 */
    function dotUp(key) {
      var dot = KEY_TO_DOT[key.toLowerCase()];
      if (!dot) return false;
      if (!Object.prototype.hasOwnProperty.call(state.heldDots, dot)) {
        return true; // 无对应按下（reset 后残留的 keyup 等），忽略且不补写
      }
      var pressEpoch = state.heldDots[dot];
      delete state.heldDots[dot];

      if (pressEpoch !== state.epoch) return true; // 旧代次的松开，作废

      // 首次松开：正在收键的组立刻停止收键
      if (state.collecting && Object.prototype.hasOwnProperty.call(state.collecting.dots, dot)) {
        var closed = state.collecting;
        state.collecting = null;
        state.finishing.push(closed);
      }

      // 找出所有包含该点的未完成组（交叠情况下可能不止一个）
      for (var i = 0; i < state.finishing.length; i++) {
        var grp = state.finishing[i];
        if (Object.prototype.hasOwnProperty.call(grp.dots, dot)) {
          delete grp.dots[dot];
          if (Object.keys(grp.dots).length === 0) {
            // 该组键已全部松开 -> 成字入队（空掩码组不出字）
            state.finishing.splice(i, 1);
            i--;
            if (grp.mask !== 0 && grp.epoch === state.epoch) {
              state.queue.push({
                type: 'char',
                text: String.fromCharCode(BRAILLE_BASE + grp.mask),
                seq: grp.seq,
                epoch: grp.epoch
              });
            }
          }
        }
      }
      flush();
      return true;
    }

    /** 空格键按下（空格没有“组”，按下即记录，按按下顺序排队）。 */
    function spaceDown(repeat) {
      if (repeat) return true;
      state.queue.push({
        type: 'space',
        text: ' ',
        seq: state.seq++,
        epoch: state.epoch
      });
      flush();
      return true;
    }

    /** 丢弃一切尚未写入的内容，并让此前按下的键的后续事件失效。 */
    function reset() {
      state.epoch++;
      state.collecting = null;
      state.finishing = [];
      state.queue = [];
      state.heldDots = {};
    }

    /** 仅供测试/界面观察用的快照。 */
    function snapshot() {
      return {
        collecting: state.collecting
          ? { mask: state.collecting.mask, seq: state.collecting.seq }
          : null,
        finishing: state.finishing.map(function (g) {
          return { mask: g.mask, remaining: Object.keys(g.dots).length, seq: g.seq };
        }),
        queued: state.queue.map(function (e) { return e.text; }),
        held: Object.keys(state.heldDots).map(Number).sort(),
        epoch: state.epoch
      };
    }

    return {
      dotDown: dotDown,
      dotUp: dotUp,
      spaceDown: spaceDown,
      reset: reset,
      snapshot: snapshot,
      // 测试辅助
      _state: state
    };
  }

  return {
    createMachine: createMachine,
    KEY_TO_DOT: KEY_TO_DOT,
    dotsToChar: dotsToChar,
    BRAILLE_BASE: BRAILLE_BASE
  };
});
