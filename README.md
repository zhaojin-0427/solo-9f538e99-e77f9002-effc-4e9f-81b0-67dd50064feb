# 六键盲文录入练习

浏览器端的六键盲文录入练习页，Flask 提供服务，Docker Compose 启动。

## 键位

| 物理键 | F | D | S | J | K | L |
| ------ | - | - | - | - | - | - |
| 盲文点号 | 第 1 点 | 第 2 点 | 第 3 点 | 第 4 点 | 第 5 点 | 第 6 点 |

一组点键的组合映射为一个 Unicode 盲文字符（区段 U+2800，点 n 占二进制位
2^(n-1)），例如 F+D = ⠃（U+2803），六点全按 = ⠿（U+283F）。

## 运行

```bash
docker compose up --build
# 浏览器打开 http://localhost:8000/
```

本地无 Docker 时的等价运行方式：

```bash
pip install -r app/requirements.txt
python app/app.py          # 监听 0.0.0.0:8000
```

## 录入规则与实现对应

| 规则 | 实现位置 |
| ---- | -------- |
| F/D/S/J/K/L 对应第 1~6 点，组合输出 Unicode 盲文 | `app/static/braille-core.js`：`KEY_TO_DOT`、`dotsToChar` |
| 忽略长按自动重复 | `dotDown`/`spaceDown` 对 `event.repeat` 直接返回 |
| 首次松开其中一键即停止收键，余键未松可起下一组（组可交叠） | `dotUp` 关闭 `collecting` 组并转入 `finishing`；下一次 `dotDown` 无收集组即新建 |
| 组内键全部松开后才落字 | 组的剩余点号集合为空时才入队 |
| 按各组首键 / 空格键的按下顺序写入 | 每个条目带单调 `seq`，`flush` 每次取最小 `seq` |
| 有选区时首字符替换选中内容 | `braille-ui.js` 的 `insertText` 用 `selectionStart/End` 切片替换，选区随后收为光标 |
| 移动光标 / 改选区 / 失焦 / 切窗时丢弃未写入内容，之后松键不补写 | `selectionchange`、编辑框 `blur`、窗口 `blur`、`visibilitychange` 统一调 `machine.reset()`；`epoch` 代次让残留 keyup 失效 |
| 程序自身写入引发的 selectionchange 不被误判 | 写入后记录选区指纹，事件回调按指纹比对消费 |
| 撤销/重做：按钮 + Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z（另兼容 Ctrl+Y） | `braille-ui.js` 的 `createHistory` 记录栈；快捷键在 document/window 捕获并 `preventDefault`，不与浏览器原生撤销叠加 |
| 六键录入与浏览器原生编辑共用一份历史；点字、空格逐个记，剪切/粘贴/换行/删除每次操作记，正文变化才入史 | 六键每次 sink 调 `history.commit`；原生编辑统一走 textarea 的 `input` 事件提交 |
| 撤销恢复这一步之前的正文与光标/选区，重做恢复这一步之后的状态 | 每条记录独立保存 `before`/`after` 两份 `{value,start,end}` 快照 |
| 撤销后移动光标/改选区仍可重做，只有新的正文改动清除重做 | `selectionchange` 只丢弃待写点键、不碰历史；`commit` 才清空 redo 栈 |
| 发起撤销/重做即丢弃待写点字与空格；无记录时随后松键也不补写 | `undo()`/`redo()` 无条件先调 `machine.reset()`（提升 epoch），再尝试取快照 |

### 原生编辑的“操作前快照”如何拿到

真实浏览器在 `beforeinput`/`paste`/`cut`/普通 `keydown` 时即可记录操作前选区；
此外 `braille-ui.js` 包装了编辑框实例的 `value` 赋值器与 `setSelectionRange`，
因此在 jsdom 等不实现原生编辑的环境里，“先设选区、再赋新 value、最后派发
`input` 事件”的模拟方式也能准确恢复操作前正文与原选区。

## 测试

测试为纯 Node（内置 test runner）+ jsdom，无需浏览器：

```bash
cd tests
npm install
npm test                    # 42 个用例，含针对运行中 Flask 服务的端到端冒烟
```

测试文件：

- `core.test.js`：状态机纯逻辑（10 例）。
- `ui.test.js`：jsdom DOM 绑定与丢弃策略（13 例，原有，全部保持通过）。
- `local-history-verification.test.js`：撤销/重做与统一历史（18 例），覆盖点字/空格
  逐步撤销、Ctrl/Meta 与 Shift 组合、粘贴/删除/换行/剪切的操作粒度与选区恢复、
  撤销后移动选区保留重做、新改动清重做、撤销/重做丢弃待写点键、空历史松键不补写、
  按钮与注入式按钮、`beforeinput` 路径、混合流程逐步往返、纯历史栈。
- `e2e.test.js`：对运行中 Flask 服务的端到端冒烟（1 例）。

关键场景：

- **交叠按键**：F+D 按下、先松 D（组停止收键、F 仍按住），不松 F 直接按 J 起下一组；
  J 组先成字 ⠊，F 最后松开后 F+D 组成字 ⠃。
- **中途改选区**：F+S 按住、松 S 后移动光标，未写入的组被丢弃，随后松 F 不补写。
- 另覆盖长按重复、空格排序、选区替换、失焦、切窗、未聚焦不收键等。

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── app
│   ├── app.py               # Flask 入口
│   ├── requirements.txt
│   ├── templates/index.html # 练习页
│   └── static
│       ├── braille-core.js  # 录入状态机（纯逻辑，可独立单测）
│       └── braille-ui.js    # DOM 绑定、丢弃策略与统一撤销/重做历史
└── tests
    ├── core.test.js
    ├── ui.test.js
    └── e2e.test.js
```
