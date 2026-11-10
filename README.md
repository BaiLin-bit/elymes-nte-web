# 在网页上与曳尔沐聊天

`elymes-nte-web` —— 把聊天页做成 QQ2007 / Windows 98 那种老窗口：独立开一个无地址栏的窗口，右侧像素立绘跟着对话关键词换表情，另外附带一只会躲光标的透明桌宠。

> 原名「千禧年外壳」（`cortico-world-millennium`）。这一版是去过宿主耦合、可以单独分发的形态。

![聊天窗口](assets/screenshot.png)

## 它做了什么

- **独立窗口**：不往宿主页面上盖皮肤，而是拉起本地服务，再用 Edge / Chrome 的 `--app` 模式开窗口，DOM 完全自己写。
- **窗口内四个面板**：File 对话 / Edit 设置 / View 插件列表 / Help 接入·人格记忆·诊断，不用回宿主界面就能调。
- **像素立绘**：13 张立绘分成 5 组动作（说话 / 介绍 / 大笑 / 生气 / 张望），按回复里的关键词自动切换，带 CRT 扫描线和轻微抖动。
- **透明桌宠**：32 张动画素材，会自己逛、会躲光标、双击受击闪白、右键有菜单，单击能唤起聊天窗口。
- **本地反代**：Core 的 WebSocket 握手会拒绝跨站 Origin，而浏览器发的 WS 一定带 Origin；本地服务在 Node 侧转发不带 Origin，握手才能过。

## 安装

这是个 **Coopanion world 插件**，需要宿主才能跑（它自己不是独立应用）。

### 放进宿主

1. 把整个目录放到 `<Coopanion>/data/extensions/elymes-nte-web/`
2. 在 `<Coopanion>/data/extensions/package.json` 的 `dependencies` 里加一行：

   ```json
   "elymes-nte-web": "file:./elymes-nte-web"
   ```

3. 在 `data/extensions/` 下执行 `npm install`（或手工把目录链接到 `node_modules/elymes-nte-web`）
4. 重启 Coopanion，在「世界与插件」里启用 **在网页上与曳尔沐聊天**

### 从 npm 装

```bash
npm i elymes-nte-web
```

## 怎么用

启用后，插件面板（「世界与插件」→ 在网页上与曳尔沐聊天）里有这些操作：

| 操作 | 作用 |
|---|---|
| 打开聊天窗口 | 起本地服务 + 开独立窗口 |
| 打开桌宠 | 优先塞进宿主的透明浮层，拿不到就退回 Edge 小窗 |
| 关闭窗口 / 关闭桌宠 | 收掉对应进程 |
| 导入立绘 | 选本地图片按动作分组写入 `assets/portrait/`，重开窗口生效 |

桌宠的交互：单击唤起聊天窗口、双击受击、右键菜单（打开聊天 / 别躲我 / 随便逛逛 / 藏起来）。

### 窗口里的菜单

窗口顶部有一排菜单，点开就是不同的面板：

| 菜单 | 面板内容 |
|---|---|
| File | 对话（默认页） |
| Edit | 设置：立绘尺寸 60/75/90/120 px、桌宠避让 90/130/200、移动速度 0.6/1/1.6、是否原地休息，改完按「保存」 |
| View | 已装插件列表（从扩展目录读名字和版本） |
| Help | 三个页签：接入（Core 地址、端口、连接状态）、人格记忆（读改 `CONSTITUTION.md`）、诊断（core.log 尾部 + 端口 + Node 版本） |

Edit 里的设置存成文件，桌宠那边会立刻收到，不用重启。

## 配置

配置分两处，互不干扰。

### 一、窗口设置（存在扩展目录里）

窗口 Edit 面板和桌宠共用一份 `state/pet-config.json`，由本地服务读写。删掉这个文件就恢复默认。

| 键 | 默认 | 说明 |
|---|---|---|
| `size` | `60` | 桌宠尺寸，24–200 px |
| `avoidIn` | `130` | 光标进到多少 px 以内开始躲 |
| `avoidOut` | `200` | 躲到多远算安全 |
| `speed` | `1` | 移动速度倍率，0.3–3 |
| `rest` | `true` | 逛累了会不会原地休息 |
| `restMsMin` / `restMsMax` | `3500` / `7000` | 每次休息时长区间（毫秒） |
| `restGapMin` / `restGapMax` | `6000` / `14000` | 两次休息的间隔区间（毫秒） |

写坏或手改超界的值会被夹回合理区间，不会让窗口报错。

### 二、宿主的皮肤面板（存在浏览器里）

`tools/webui.source.js` 那套复古皮肤设置存在 localStorage 的 `elymes-nte-web.skin.v1` 下：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否启用复古皮肤 |
| `glitch` | `true` | 立绘切换时的抖动/故障效果 |
| `closeSendsX` | `true` | 关窗口时是否往输入框塞一个 X |
| `portraitWidth` | `320` | 立绘宽度（180–560） |
| `idleFace` | `'talk'` | 空闲时用哪组动作 |
| `faces` | 5 组内置 | 每组的帧、帧间隔、触发关键词 |
| `kaomoji` | 12 个 | 底部颜文字快捷键 |

### 环境变量（可选）

| 变量 | 说明 |
|---|---|
| `ENW_PORT` | 本地服务端口，默认 `18800` |
| `ENW_CORE` | 上游 Core 地址，默认 `http://127.0.0.1:17788` |
| `ENW_PET_HOST` | 手动指定透明桌宠的宿主命令（JSON 数组） |
| `ENW_HOME` | 宿主 home 目录，用来找人性和日志（见下节） |
| `CORTICO_HOME` | 同上，宿主自己会设；没设 `ENW_HOME` 时读这个 |
| `CORTICO_EXTENSIONS_DIR` | 扩展目录，View 面板列插件用 |

## 和宿主深集成的那三样（可选）

Help 面板里的「人格记忆」和「诊断」、View 面板里的「插件列表」，读的是宿主自己的文件：

| 能力 | 读的路径 | 从哪来 |
|---|---|---|
| 人格记忆 | `<home>/companion/workspace/CONSTITUTION.md` | `ENW_HOME` → `CORTICO_HOME` → 往上推两级猜 |
| 记忆条目 | `<home>/companion/workspace/notes/` | 同上 |
| 诊断日志 | `<home>/../logs/core.log` | 同上 |
| 插件列表 | `CORTICO_EXTENSIONS_DIR` → 包目录上一级 | 环境变量优先 |

**这三样都不是必需品。** 拿不到路径时，对应面板显示「未配置」并说明原因，聊天、桌宠、立绘全部照常。装在非 Coopanion 环境里唯一要做的就是把 `ENW_HOME` 指到别处，或者干脆不管。

## 目录结构

```
src/index.mjs            插件入口（world 定义：面板、窗口、桌宠、立绘导入）
tools/window-server.mjs  本地服务：静态页 + 反代上游 WS + 窗口面板接口
tools/window/            独立窗口的页面（index.html / window.js / window.css / pet.html）
tools/webui.source.js    宿主 WebUI 面板源码
tools/build.mjs          把面板源码 + 内联 base64 素材打成 dist/webui.js
dist/webui.js            面板产物（构建出来的，别手改）
dist/webui.css           面板样式
assets/portrait/         立绘 13 张
assets/pet/              桌宠动画 32 张
assets/fonts/            破晓像素字体
state/pet-config.json    窗口设置（运行时生成，不进包也不提交）
```

## 开发

```bash
# 改完 tools/webui.source.js 或换了素材后重新构建
node tools/build.mjs

# 单独把本地服务跑起来调试（不带宿主）
node tools/window-server.mjs
# 然后浏览器打开 http://127.0.0.1:18800/
```

`tools/` 下还有一批 `probe-*.mjs`，是当初逆向宿主接口时写的探针脚本，留作参考，不参与运行。

## 素材来源

立绘、桌宠素材和字体都不是本仓库原创，来源与授权见 [assets/SOURCES.md](assets/SOURCES.md)。**商用前请先确认原权利人授权。**

## 许可

代码以 MIT 许可发布，见 [LICENSE](LICENSE)。素材部分另有约束，见上。
