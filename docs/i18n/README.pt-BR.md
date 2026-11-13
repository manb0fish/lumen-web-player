<div align="center">

# Lumen Player

**Um reprodutor de vídeo poderoso que roda inteiramente no seu navegador.**

[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · **Português** · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md)

![Lumen Player com o tema Modern Glass](../screenshots/skin-glass.png)

</div>

> Este documento é uma tradução. Em caso de divergência, vale o [README em inglês](../../README.md).

## O que é o Lumen?

O Lumen é um reprodutor de mídia que você abre em uma aba do navegador. Pense em um reprodutor
de desktop como o mpv ou o VLC, reconstruído com tecnologia web moderna. Seus arquivos nunca
saem do seu computador: tudo é decodificado e exibido localmente, na própria página.

O que ele faz:

- **Reproduz quase tudo.** Arquivos MP4, MKV, WebM, MPEG-TS, AVI e FLV; vídeo H.264, HEVC, VP9,
  AV1 e formatos mais antigos; áudio AAC, Opus, MP3, AC-3 e FLAC. Quando o navegador não consegue
  decodificar um arquivo sozinho, o Lumen recorre a uma cópia embutida do FFmpeg.
- **Mantém a fluidez e a sincronia.** Sempre que possível, o vídeo é decodificado pelo hardware
  gráfico e desenhado pela GPU, e a imagem fica sincronizada com o som com poucos milissegundos
  de margem.
- **Exibe legendas corretamente.** Legendas ASS/SSA com estilo (as usadas em anime e karaokê),
  SRT, WebVTT e PGS de Blu-ray, incluindo faixas de legenda e fontes guardadas dentro de
  arquivos MKV.
- **Muda de aparência.** Vem com três temas, e você pode criar o seu com um pequeno arquivo JSON.
- **Pode ser controlado pelo teclado.** Os mesmos atalhos do mpv: avanço quadro a quadro,
  controle de velocidade, atraso de legenda, loop A-B e mais.
- **Funciona em celulares e tablets.** Os controles se reorganizam sozinhos em telas pequenas e
  respondem ao toque: toque duas vezes à esquerda ou à direita da imagem para pular 10 segundos.
- **Mostra o que acontece por dentro.** Pressione `i` para abrir um painel de estatísticas em
  tempo real.

| Modern Glass | mpv OSC (com estatísticas) | Studio Deck |
| --- | --- | --- |
| ![Tema Modern Glass](../screenshots/skin-glass.png) | ![Tema mpv OSC](../screenshots/skin-mpv.png) | ![Tema Studio Deck](../screenshots/skin-studio.png) |

## Antes de começar

Você precisa ter três coisas instaladas:

1. **Node.js 22 ou mais recente** (20.19 ou superior também funciona): baixe em
   [nodejs.org](https://nodejs.org). Para conferir, abra um terminal e execute `node --version`.
2. **Git**: baixe em [git-scm.com](https://git-scm.com).
3. **Microsoft Edge ou Google Chrome**, em uma versão recente. O Lumen depende de recursos novos
   dos navegadores (WebCodecs, WebGPU), e esses são os dois navegadores em que ele é testado.

Você também precisa de cerca de 500 MB de espaço livre em disco para as dependências e os vídeos
de exemplo.

## Primeiros passos

Abra um terminal (no Windows: PowerShell ou Windows Terminal) e execute estes comandos, um de
cada vez.

**1. Baixe o código**

```bash
git clone https://github.com/manb0fish/lumen-web-player.git
```

```bash
cd lumen-web-player
```

**2. Instale as dependências** (leva um ou dois minutos)

```bash
npm install
```

**3. Crie os vídeos de exemplo** (opcional, mas assim você já tem o que reproduzir)

```bash
npm run media
```

Isso gera cerca de 30 clipes de teste curtos no seu computador. Nada é baixado.

**4. Inicie o reprodutor**

```bash
npm run dev
```

Agora abra **<http://127.0.0.1:5173>** no Edge ou no Chrome. Você verá o reprodutor com uma lista
de clipes de exemplo à esquerda. Clique em qualquer um para reproduzir.

Para parar o reprodutor, volte ao terminal e pressione `Ctrl+C`.

## Como usar o reprodutor

- **Reproduzir um arquivo seu:** arraste-o para o reprodutor ou clique no ícone de pasta.
- **Adicionar legendas:** arraste um arquivo `.ass`, `.srt`, `.vtt` ou `.sup` para o reprodutor.
  Legendas dentro de arquivos MKV são encontradas automaticamente; escolha uma no menu de
  legendas.
- **Trocar o tema:** clique no ícone de paleta ou pressione `K`.
- **Alterar as opções de qualidade de imagem:** o ícone de controles deslizantes abre os ajustes
  de renderizador, redimensionamento e filtros.
- **Ver detalhes técnicos:** pressione `i`.

### Atalhos de teclado úteis

| Tecla | O que faz |
| --- | --- |
| `Space` | Reproduzir / pausar |
| `←` `→` | Voltar / avançar 5 segundos |
| `,` `.` | Voltar / avançar um quadro |
| `[` `]` | Mais devagar / mais rápido |
| `9` `0` | Diminuir / aumentar o volume |
| `m` | Silenciar |
| `z` `x` | Adiantar / atrasar as legendas |
| `v` | Mostrar / ocultar as legendas |
| `l` | Loop entre dois pontos (pressione em A, pressione em B, pressione de novo para limpar) |
| `f` | Tela cheia |
| `K` | Próximo tema |
| `i` | Estatísticas |

A lista completa, e como alterar os atalhos, está no [guia](../GUIDE.md#keyboard-shortcuts) (em
inglês).

## Problemas comuns

**`npm run media` diz que o ffmpeg não foi encontrado.**
O pacote auxiliar do ffmpeg não conseguiu executar o instalador. Execute estes dois comandos e
tente de novo:

```bash
npm install-scripts approve ffmpeg-static
```

```bash
npm rebuild ffmpeg-static
```

Se o primeiro comando for dado como desconhecido, sua versão do npm é mais antiga e não precisa
dele: execute apenas o segundo.

**A lista de exemplos está vazia.**
Execute `npm run media` e recarregue a página.

**A página não carrega.**
Confira se `npm run dev` continua rodando no terminal e se o endereço é exatamente
`http://127.0.0.1:5173`.

**Aparece "Audio is blocked by the browser".**
Os navegadores não deixam uma página começar a tocar som sozinha. Clique uma vez no reprodutor e
aperte o play.

**Não funciona no Firefox nem no Safari.**
Por enquanto, use o Microsoft Edge ou o Google Chrome. São os navegadores em que o Lumen é
desenvolvido e testado.

**Um arquivo não reproduz.**
Pressione `i` para ver qual decodificador foi escolhido e por quê. Uma limitação conhecida: o
FFmpeg embutido não decodifica vídeo AV1, então é preciso um navegador que suporte AV1 por conta
própria (as versões atuais do Edge e do Chrome suportam).

## Para desenvolvedores

O Lumen também é uma biblioteca: um núcleo de reprodução sem interface, com uma interface de
usuário opcional por cima.

```ts
import { Player, mountUI } from './src';

const player = new Player({ container });
mountUI(player, container, { skin: 'glass' });
await player.load(fileOrUrl, { autoplay: true });
player.command('seek 30 absolute');
```

Execute as verificações:

```bash
npm run lint
```

```bash
npm test
```

Para saber mais (em inglês):

- [Guia](../GUIDE.md): opções de URL, todos os atalhos, como incorporar em uma página, como criar
  temas e o conjunto de testes.
- [Arquitetura](../ARCHITECTURE.md): como funcionam a decodificação, a renderização, a
  sincronia de áudio e as legendas, e as escolhas de projeto por trás delas.
- [Verificação](../VERIFICATION.md): o que os 186 testes automatizados medem e os resultados.

## Autores

- [manb0fish](https://github.com/manb0fish)
- [Claude](https://claude.com/claude-code), o modelo de IA da Anthropic: coautor do código, dos
  testes e da documentação

## Licença

O Lumen Player é software livre, distribuído sob a
[Licença Pública Geral GNU v3.0](../../LICENSE).

Ele se apoia em outros projetos de código aberto que mantêm suas próprias licenças, entre eles o
[FFmpeg](https://ffmpeg.org) (por meio do `@ffmpeg/core`, GPL), o
[libass](https://github.com/libass/libass) (por meio do JASSUB, LGPL e outras) e o
[Mediabunny](https://mediabunny.dev) (MPL-2.0).
