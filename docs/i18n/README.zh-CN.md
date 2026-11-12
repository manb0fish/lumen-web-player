<div align="center">

# Lumen Player

**一款完全运行在浏览器里的强大视频播放器。**

[English](../../README.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md)

![使用 Modern Glass 皮肤的 Lumen Player](../screenshots/skin-glass.png)

</div>

> 本文档是译文，如与[英文版 README](../../README.md) 有出入，请以英文版为准。

## Lumen 是什么？

Lumen 是一款在浏览器标签页里打开的媒体播放器。你可以把它理解为用现代 Web 技术重新实现的
mpv 或 VLC 这类桌面播放器。你的文件不会离开你的电脑：解码和显示全部在本地页面中完成。

它能做到：

- **几乎什么都能播。** 支持 MP4、MKV、WebM、MPEG-TS、AVI、FLV 文件；H.264、HEVC、VP9、AV1
  以及较老的视频编码；AAC、Opus、MP3、AC-3、FLAC 音频。当浏览器自身无法解码某个文件时，
  Lumen 会改用内置的 FFmpeg。
- **流畅且音画同步。** 尽可能使用显卡硬件解码并由 GPU 绘制画面，音画误差控制在几毫秒以内。
- **正确显示字幕。** 支持带样式的 ASS/SSA 字幕（动画和卡拉OK常用的那种）、SRT、WebVTT 和
  蓝光 PGS，也能读取 MKV 文件内嵌的字幕轨和字体。
- **可以换外观。** 内置三套皮肤，你也可以用一个小小的 JSON 文件制作自己的皮肤。
- **全键盘操作。** 快捷键与 mpv 相同：逐帧步进、变速、字幕延迟、A-B 循环等。
- **看得见内部状态。** 按 `i` 打开实时的“技术统计信息”面板。

| Modern Glass | mpv OSC（含统计信息） | Studio Deck |
| --- | --- | --- |
| ![Modern Glass 皮肤](../screenshots/skin-glass.png) | ![mpv OSC 皮肤](../screenshots/skin-mpv.png) | ![Studio Deck 皮肤](../screenshots/skin-studio.png) |

## 开始之前

你需要先安装三样东西：

1. **Node.js 22 或更高版本**（20.19 以上也可以）——从 [nodejs.org](https://nodejs.org) 下载。
   打开终端运行 `node --version` 即可检查版本。
2. **Git**——从 [git-scm.com](https://git-scm.com) 下载。
3. **较新版本的 Microsoft Edge 或 Google Chrome**。Lumen 依赖较新的浏览器特性
   （WebCodecs、WebGPU），目前只在这两款浏览器上测试过。

另外还需要大约 500 MB 的可用磁盘空间，用于存放依赖和示例视频。

## 快速上手

打开终端（Windows 上使用 PowerShell 或 Windows Terminal），依次运行下面的命令。

**1. 下载代码**

```bash
git clone https://github.com/manb0fish/lumen-web-player.git
```

```bash
cd lumen-web-player
```

**2. 安装依赖**（需要一两分钟）

```bash
npm install
```

**3. 生成示例视频**（可选，但这样马上就有东西可以播放）

```bash
npm run media
```

这一步会在你的电脑上生成大约 30 个测试短片，不会下载任何内容。

**4. 启动播放器**

```bash
npm run dev
```

然后用 Edge 或 Chrome 打开 **<http://127.0.0.1:5173>**。你会看到播放器，左侧是示例短片列表，
点击任意一个即可播放。

要停止播放器，回到终端按 `Ctrl+C`。

## 使用播放器

- **播放自己的文件：** 把文件拖到播放器上，或点击文件夹图标。
- **添加字幕：** 把 `.ass`、`.srt`、`.vtt` 或 `.sup` 文件拖到播放器上。MKV 文件内嵌的字幕会被
  自动识别，在字幕菜单中选择即可。
- **切换皮肤：** 点击调色板图标，或按 `K`。
- **调整画质选项：** 点击滑块图标，可以设置渲染器、缩放算法和滤镜。
- **查看技术细节：** 按 `i`。

### 常用快捷键

| 按键 | 作用 |
| --- | --- |
| `Space` | 播放 / 暂停 |
| `←` `→` | 后退 / 前进 5 秒 |
| `,` `.` | 后退 / 前进一帧 |
| `[` `]` | 减速 / 加速 |
| `9` `0` | 音量减 / 加 |
| `m` | 静音 |
| `z` `x` | 让字幕提前 / 延后出现 |
| `v` | 显示 / 隐藏字幕 |
| `l` | 在两点之间循环（在 A 点按一次，在 B 点按一次，再按一次取消） |
| `f` | 全屏 |
| `K` | 下一套皮肤 |
| `i` | 技术统计信息 |

完整的快捷键列表以及修改方法，见[使用指南](../GUIDE.md#keyboard-shortcuts)（英文）。

## 常见问题

**`npm run media` 提示找不到 ffmpeg。**
ffmpeg 辅助包的安装脚本没有运行。执行下面两条命令后再试一次：

```bash
npm install-scripts approve ffmpeg-static
```

```bash
npm rebuild ffmpeg-static
```

如果第一条命令提示“未知命令”，说明你的 npm 版本较旧，不需要这一步，直接运行第二条即可。

**示例列表是空的。**
运行 `npm run media`，然后刷新页面。

**页面打不开。**
确认终端里的 `npm run dev` 仍在运行，并且地址完全是 `http://127.0.0.1:5173`。

**出现“Audio is blocked by the browser”。**
浏览器不允许页面自行开始播放声音。点击一下播放器，再按播放即可。

**在 Firefox 或 Safari 中无法使用。**
目前请使用 Microsoft Edge 或 Google Chrome，Lumen 是在这两款浏览器上开发和测试的。

**某个文件无法播放。**
按 `i` 查看选用了哪种解码方式及其原因。已知的一个限制：内置的 FFmpeg 无法解码 AV1 视频，
因此需要浏览器自身支持 AV1（当前版本的 Edge 和 Chrome 都支持）。

## 面向开发者

Lumen 同时也是一个库：一个无界面的播放器核心，外加一层可选的用户界面。

```ts
import { Player, mountUI } from './src';

const player = new Player({ container });
mountUI(player, container, { skin: 'glass' });
await player.load(fileOrUrl, { autoplay: true });
player.command('seek 30 absolute');
```

运行检查：

```bash
npm run lint
```

```bash
npm test
```

延伸阅读（英文）：

- [使用指南](../GUIDE.md)——URL 参数、全部快捷键、嵌入到自己的页面、编写皮肤、测试套件。
- [架构说明](../ARCHITECTURE.md)——解码、渲染、音频同步和字幕的工作原理，以及背后的取舍。
- [验证结果](../VERIFICATION.md)——163 项自动化测试测量了什么，结果如何。

## 作者

- [manb0fish](https://github.com/manb0fish)
- [Claude](https://claude.com/claude-code)，Anthropic 的 AI 模型——代码、测试和文档的共同作者

## 许可证

Lumen Player 是自由软件，以 [GNU 通用公共许可证第 3 版（GPL-3.0）](../../LICENSE)发布。

它建立在其他开源项目之上，这些项目保留各自的许可证，包括 [FFmpeg](https://ffmpeg.org)
（通过 `@ffmpeg/core`，GPL）、[libass](https://github.com/libass/libass)（通过 JASSUB，LGPL 等）
和 [Mediabunny](https://mediabunny.dev)（MPL-2.0）。
