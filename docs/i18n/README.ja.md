<div align="center">

# Lumen Player

**ブラウザだけで動作する、高機能な動画プレーヤー。**

[English](../../README.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md)

![Modern Glass スキンの Lumen Player](../screenshots/skin-glass.png)

</div>

> このドキュメントは翻訳です。内容に相違がある場合は[英語版 README](../../README.md) を正とします。

## Lumen とは

Lumen はブラウザのタブで開くメディアプレーヤーです。mpv や VLC のようなデスクトップ向け
プレーヤーを、最新の Web 技術で作り直したものだと考えてください。ファイルがお使いの
コンピューターの外に送られることはありません。デコードも表示も、すべてページ内でローカルに
行われます。

できること:

- **ほとんど何でも再生。** MP4、MKV、WebM、MPEG-TS、AVI、FLV の各ファイル、H.264、HEVC、VP9、
  AV1 や古い映像コーデック、AAC、Opus、MP3、AC-3、FLAC の音声に対応します。ブラウザ単体で
  デコードできないファイルは、内蔵の FFmpeg に切り替えて再生します。
- **なめらかで、音ズレしない。** 可能な限りグラフィックスハードウェアでデコードし、GPU で
  描画します。映像と音声のずれは数ミリ秒以内に保たれます。
- **字幕を正しく表示。** スタイル付きの ASS/SSA 字幕（アニメやカラオケで使われる形式）、SRT、
  WebVTT、Blu-ray の PGS に対応し、MKV ファイルに格納された字幕トラックやフォントも扱えます。
- **見た目を変えられる。** 3 種類のスキンを内蔵し、小さな JSON ファイルで自作もできます。
- **キーボードで操作できる。** mpv と同じショートカット（コマ送り、再生速度、字幕の遅延、
  A-B ループなど）が使えます。
- **内部の状態が見える。** `i` を押すと、リアルタイムの統計情報パネルが開きます。

| Modern Glass | mpv OSC（統計情報付き） | Studio Deck |
| --- | --- | --- |
| ![Modern Glass スキン](../screenshots/skin-glass.png) | ![mpv OSC スキン](../screenshots/skin-mpv.png) | ![Studio Deck スキン](../screenshots/skin-studio.png) |

## はじめる前に

次の 3 つをインストールしておいてください。

1. **Node.js 22 以降**（20.19 以降でも動作します）— [nodejs.org](https://nodejs.org) から入手
   できます。ターミナルで `node --version` を実行すると確認できます。
2. **Git** — [git-scm.com](https://git-scm.com) から入手できます。
3. **Microsoft Edge または Google Chrome の新しいバージョン。** Lumen は新しいブラウザ機能
   （WebCodecs、WebGPU）を利用しており、動作確認はこの 2 つのブラウザで行っています。

このほか、依存パッケージとサンプル動画のために約 500 MB の空き容量が必要です。

## はじめかた

ターミナル（Windows では PowerShell または Windows Terminal）を開き、次のコマンドを 1 つずつ
実行します。

**1. コードをダウンロードする**

```bash
git clone https://github.com/manb0fish/lumen-web-player.git
```

```bash
cd lumen-web-player
```

**2. 依存パッケージをインストールする**（1〜2 分かかります）

```bash
npm install
```

**3. サンプル動画を作成する**（省略できますが、すぐに再生を試せます）

```bash
npm run media
```

約 30 本の短いテスト用クリップがお使いのコンピューター上で生成されます。何もダウンロード
されません。

**4. プレーヤーを起動する**

```bash
npm run dev
```

Edge または Chrome で **<http://127.0.0.1:5173>** を開きます。プレーヤーが表示され、左側に
サンプルクリップの一覧が並びます。どれかをクリックすると再生されます。

プレーヤーを止めるには、ターミナルに戻って `Ctrl+C` を押します。

## プレーヤーの使い方

- **自分のファイルを再生する:** ファイルをプレーヤーにドラッグするか、フォルダーのアイコンを
  クリックします。
- **字幕を追加する:** `.ass`、`.srt`、`.vtt`、`.sup` ファイルをプレーヤーにドラッグします。
  MKV ファイル内の字幕は自動的に検出されるので、字幕メニューから選んでください。
- **スキンを変える:** パレットのアイコンをクリックするか、`K` を押します。
- **画質の設定を変える:** スライダーのアイコンから、レンダラー、スケーラー、フィルターを
  設定できます。
- **技術的な詳細を見る:** `i` を押します。

### よく使うキーボードショートカット

| キー | 動作 |
| --- | --- |
| `Space` | 再生 / 一時停止 |
| `←` `→` | 5 秒戻る / 進む |
| `,` `.` | 1 フレーム戻る / 進む |
| `[` `]` | 遅くする / 速くする |
| `9` `0` | 音量を下げる / 上げる |
| `m` | ミュート |
| `z` `x` | 字幕を早める / 遅らせる |
| `v` | 字幕の表示 / 非表示 |
| `l` | 2 点間をループ（A 点で押す、B 点で押す、もう一度押すと解除） |
| `f` | 全画面表示 |
| `K` | 次のスキン |
| `i` | 統計情報 |

すべてのショートカットと変更方法は[ガイド](../GUIDE.md#keyboard-shortcuts)（英語）にあります。

## よくある問題

**`npm run media` で ffmpeg が見つからないと表示される。**
ffmpeg の補助パッケージがインストールスクリプトを実行できていません。次の 2 つのコマンドを
実行してから、もう一度試してください。

```bash
npm install-scripts approve ffmpeg-static
```

```bash
npm rebuild ffmpeg-static
```

1 つ目のコマンドで「不明なコマンド」と表示された場合は、npm が古いバージョンでこの手順が
不要なので、2 つ目だけを実行してください。

**サンプルの一覧が空になっている。**
`npm run media` を実行してから、ページを再読み込みしてください。

**ページが開かない。**
ターミナルで `npm run dev` が動いたままになっていること、アドレスが正確に
`http://127.0.0.1:5173` であることを確認してください。

**「Audio is blocked by the browser」と表示される。**
ブラウザは、ページが勝手に音を鳴らし始めることを許可しません。プレーヤーを一度クリックして
から再生してください。

**Firefox や Safari で動かない。**
現時点では Microsoft Edge か Google Chrome を使ってください。Lumen はこの 2 つのブラウザで
開発・テストされています。

**再生できないファイルがある。**
`i` を押すと、どのデコーダーが選ばれたかとその理由を確認できます。既知の制限として、内蔵の
FFmpeg では AV1 映像をデコードできないため、ブラウザ自体が AV1 に対応している必要があります
（現在の Edge と Chrome は対応しています）。

## 開発者向け

Lumen はライブラリとしても使えます。UI を持たないプレーヤーのコアと、その上に載せる任意の
ユーザーインターフェースで構成されています。

```ts
import { Player, mountUI } from './src';

const player = new Player({ container });
mountUI(player, container, { skin: 'glass' });
await player.load(fileOrUrl, { autoplay: true });
player.command('seek 30 absolute');
```

チェックを実行する:

```bash
npm run lint
```

```bash
npm test
```

さらに詳しく（英語）:

- [ガイド](../GUIDE.md) — URL オプション、全ショートカット、ページへの組み込み、スキンの作り方、
  テストスイート。
- [アーキテクチャ](../ARCHITECTURE.md) — デコード、レンダリング、音声同期、字幕の仕組みと、
  その設計上のトレードオフ。
- [検証結果](../VERIFICATION.md) — 163 件の自動テストが何を測定し、どのような結果だったか。

## 作者

- [manb0fish](https://github.com/manb0fish)
- [Claude](https://claude.com/claude-code)（Anthropic の AI モデル）— コード、テスト、
  ドキュメントの共同作者

## ライセンス

Lumen Player はフリーソフトウェアであり、[GNU General Public License v3.0](../../LICENSE) の
もとで公開されています。

本プロジェクトは他のオープンソースプロジェクトを利用しており、それぞれ独自のライセンスが
適用されます。[FFmpeg](https://ffmpeg.org)（`@ffmpeg/core` 経由、GPL）、
[libass](https://github.com/libass/libass)（JASSUB 経由、LGPL ほか）、
[Mediabunny](https://mediabunny.dev)（MPL-2.0）などです。
