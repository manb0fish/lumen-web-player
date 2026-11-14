<div align="center">

# Lumen Player

**웹 브라우저 안에서만 동작하는 강력한 동영상 플레이어.**

[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md) · [Français](README.fr.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md)

![Modern Glass 스킨을 적용한 Lumen Player](../screenshots/skin-glass.png)

</div>

> 이 문서는 번역본입니다. 내용이 다를 경우 [영어 README](../../README.md)를 기준으로 합니다.

## Lumen이란?

Lumen은 브라우저 탭에서 여는 미디어 플레이어입니다. mpv나 VLC 같은 데스크톱 플레이어를 최신
웹 기술로 다시 만든 것이라고 생각하면 됩니다. 파일은 컴퓨터 밖으로 나가지 않습니다. 디코딩과
화면 표시는 모두 페이지 안에서, 로컬로 이루어집니다.

할 수 있는 일:

- **거의 모든 파일 재생.** MP4, MKV, WebM, MPEG-TS, AVI, FLV 파일과 H.264, HEVC, VP9, AV1 및
  오래된 비디오 코덱, AAC, Opus, MP3, AC-3, FLAC 오디오를 지원합니다. 브라우저가 직접 디코딩할
  수 없는 파일은 내장된 FFmpeg로 전환해 재생합니다.
- **부드럽고 정확한 싱크.** 가능한 경우 그래픽 하드웨어로 디코딩하고 GPU로 그리며, 영상과
  소리의 오차는 몇 밀리초 이내로 유지됩니다.
- **자막을 제대로 표시.** 스타일이 들어간 ASS/SSA 자막(애니메이션과 노래방 자막에 쓰이는 형식),
  SRT, WebVTT, 블루레이 PGS를 지원하며, MKV 파일 안에 들어 있는 자막 트랙과 글꼴도 읽습니다.
- **모양 바꾸기.** 스킨 세 가지가 기본 제공되며, 작은 JSON 파일로 직접 만들 수도 있습니다.
- **키보드로 조작.** mpv와 같은 단축키를 씁니다. 프레임 단위 이동, 재생 속도, 자막 지연,
  A-B 반복 등을 지원합니다.
- **휴대폰과 태블릿에서도 사용.** 작은 화면에 맞게 컨트롤이 자동으로 재배치되고 터치로 조작할 수
  있습니다. 화면 왼쪽이나 오른쪽을 두 번 탭하면 10초씩 이동합니다.
- **내부 상태 확인.** `i`를 누르면 실시간 통계 정보 패널이 열립니다.

| Modern Glass | mpv OSC (통계 표시) | Studio Deck |
| --- | --- | --- |
| ![Modern Glass 스킨](../screenshots/skin-glass.png) | ![mpv OSC 스킨](../screenshots/skin-mpv.png) | ![Studio Deck 스킨](../screenshots/skin-studio.png) |

## 시작하기 전에

다음 세 가지가 설치되어 있어야 합니다.

1. **Node.js 22 이상** (20.19 이상도 가능) — [nodejs.org](https://nodejs.org)에서 받을 수
   있습니다. 터미널에서 `node --version`을 실행하면 버전을 확인할 수 있습니다.
2. **Git** — [git-scm.com](https://git-scm.com)에서 받을 수 있습니다.
3. **최신 버전의 Microsoft Edge 또는 Google Chrome.** Lumen은 새로운 브라우저 기능(WebCodecs,
   WebGPU)을 사용하며, 이 두 브라우저에서 테스트되었습니다.

그 밖에 의존성과 샘플 동영상을 위해 약 500 MB의 여유 디스크 공간이 필요합니다.

## 시작하기

터미널(Windows에서는 PowerShell 또는 Windows Terminal)을 열고 아래 명령을 하나씩 실행하세요.

**1. 코드 내려받기**

```bash
git clone https://github.com/manb0fish/lumen-web-player.git
```

```bash
cd lumen-web-player
```

**2. 의존성 설치** (1~2분 정도 걸립니다)

```bash
npm install
```

**3. 샘플 동영상 만들기** (선택 사항이지만, 바로 재생해 볼 수 있습니다)

```bash
npm run media
```

약 30개의 짧은 테스트 클립이 컴퓨터에서 생성됩니다. 아무것도 내려받지 않습니다.

**4. 플레이어 실행**

```bash
npm run dev
```

이제 Edge나 Chrome에서 **<http://127.0.0.1:5173>** 을 엽니다. 플레이어와 함께 왼쪽에 샘플 클립
목록이 보입니다. 아무 항목이나 클릭하면 재생됩니다.

플레이어를 멈추려면 터미널로 돌아가 `Ctrl+C`를 누르세요.

## 플레이어 사용법

- **내 파일 재생:** 파일을 플레이어 위로 끌어다 놓거나 폴더 아이콘을 클릭합니다.
- **자막 추가:** `.ass`, `.srt`, `.vtt`, `.sup` 파일을 플레이어 위로 끌어다 놓습니다. MKV 파일
  안의 자막은 자동으로 인식되므로 자막 메뉴에서 고르면 됩니다.
- **스킨 변경:** 팔레트 아이콘을 클릭하거나 `K`를 누릅니다.
- **화질 옵션 변경:** 슬라이더 아이콘에서 렌더러, 스케일러, 필터를 설정할 수 있습니다.
- **기술 정보 보기:** `i`를 누릅니다.

### 자주 쓰는 단축키

| 키 | 동작 |
| --- | --- |
| `Space` | 재생 / 일시정지 |
| `←` `→` | 5초 뒤로 / 앞으로 |
| `,` `.` | 한 프레임 뒤로 / 앞으로 |
| `[` `]` | 느리게 / 빠르게 |
| `9` `0` | 음량 줄이기 / 키우기 |
| `m` | 음소거 |
| `z` `x` | 자막을 더 일찍 / 더 늦게 표시 |
| `v` | 자막 표시 / 숨기기 |
| `l` | 두 지점 사이 반복 (A 지점에서 한 번, B 지점에서 한 번, 다시 누르면 해제) |
| `f` | 전체 화면 |
| `K` | 다음 스킨 |
| `i` | 통계 정보 |

전체 단축키 목록과 변경 방법은 [가이드](../GUIDE.md#keyboard-shortcuts)(영어)에 있습니다.

## 자주 생기는 문제

**`npm run media`에서 ffmpeg를 찾을 수 없다고 나옵니다.**
ffmpeg 도우미 패키지의 설치 스크립트가 실행되지 않은 것입니다. 아래 두 명령을 실행한 뒤 다시
시도하세요.

```bash
npm install-scripts approve ffmpeg-static
```

```bash
npm rebuild ffmpeg-static
```

첫 번째 명령에서 알 수 없는 명령이라고 나오면 npm이 이전 버전이라 이 단계가 필요 없는
것이니, 두 번째 명령만 실행하세요.

**샘플 목록이 비어 있습니다.**
`npm run media`를 실행한 다음 페이지를 새로 고치세요.

**페이지가 열리지 않습니다.**
터미널에서 `npm run dev`가 계속 실행 중인지, 주소가 정확히 `http://127.0.0.1:5173`인지
확인하세요.

**"Audio is blocked by the browser"라는 메시지가 보입니다.**
브라우저는 페이지가 스스로 소리를 재생하는 것을 허용하지 않습니다. 플레이어를 한 번 클릭한 뒤
재생을 누르세요.

**Firefox나 Safari에서 동작하지 않습니다.**
지금은 Microsoft Edge나 Google Chrome을 사용하세요. Lumen은 이 두 브라우저에서 개발되고
테스트됩니다.

**재생되지 않는 파일이 있습니다.**
`i`를 눌러 어떤 디코더가 선택되었는지와 그 이유를 확인하세요. 알려진 제한이 하나 있습니다.
내장 FFmpeg는 AV1 비디오를 디코딩할 수 없으므로 브라우저 자체가 AV1을 지원해야 합니다(현재의
Edge와 Chrome은 지원합니다).

## 개발자를 위한 안내

Lumen은 라이브러리이기도 합니다. UI가 없는 플레이어 코어와 그 위에 얹는 선택적 사용자
인터페이스로 구성됩니다.

```ts
import { Player, mountUI } from './src';

const player = new Player({ container });
mountUI(player, container, { skin: 'glass' });
await player.load(fileOrUrl, { autoplay: true });
player.command('seek 30 absolute');
```

검사 실행:

```bash
npm run lint
```

```bash
npm test
```

더 읽을거리(영어):

- [가이드](../GUIDE.md) — URL 옵션, 모든 단축키, 내 페이지에 넣는 방법, 스킨 만들기, 테스트
  스위트.
- [아키텍처](../ARCHITECTURE.md) — 디코딩, 렌더링, 오디오 싱크, 자막이 동작하는 방식과 그
  뒤에 있는 설계상의 절충.
- [검증 결과](../VERIFICATION.md) — 202개의 자동화 테스트가 무엇을 측정하는지와 그 결과.

## 만든 이

- [manb0fish](https://github.com/manb0fish)
- [Claude](https://claude.com/claude-code), Anthropic의 AI 모델 — 코드, 테스트, 문서의 공동 저자

## 라이선스

Lumen Player는 자유 소프트웨어이며 [GNU General Public License v3.0](../../LICENSE)으로
배포됩니다.

이 프로젝트는 각자의 라이선스를 유지하는 다른 오픈 소스 프로젝트를 기반으로 합니다.
[FFmpeg](https://ffmpeg.org)(`@ffmpeg/core`를 통해, GPL),
[libass](https://github.com/libass/libass)(JASSUB를 통해, LGPL 등),
[Mediabunny](https://mediabunny.dev)(MPL-2.0) 등이 포함됩니다.
