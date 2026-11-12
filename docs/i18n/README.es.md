<div align="center">

# Lumen Player

**Un potente reproductor de vídeo que funciona por completo en tu navegador.**

[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español** · [Français](README.fr.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md)

![Lumen Player con el tema Modern Glass](../screenshots/skin-glass.png)

</div>

> Este documento es una traducción. Si hay diferencias, prevalece el [README en inglés](../../README.md).

## ¿Qué es Lumen?

Lumen es un reproductor multimedia que se abre en una pestaña del navegador. Piensa en un
reproductor de escritorio como mpv o VLC, reconstruido con tecnología web moderna. Tus archivos
nunca salen de tu ordenador: todo se decodifica y se muestra de forma local, dentro de la página.

Lo que puede hacer:

- **Reproducir casi cualquier cosa.** Archivos MP4, MKV, WebM, MPEG-TS, AVI y FLV; vídeo H.264,
  HEVC, VP9, AV1 y formatos más antiguos; audio AAC, Opus, MP3, AC-3 y FLAC. Cuando el navegador
  no puede decodificar un archivo por sí mismo, Lumen recurre a una copia integrada de FFmpeg.
- **Mantenerse fluido y sincronizado.** Siempre que es posible, el vídeo se decodifica con el
  hardware gráfico y se dibuja con la GPU, y la imagen va sincronizada con el sonido con un
  margen de pocos milisegundos.
- **Mostrar bien los subtítulos.** Subtítulos ASS/SSA con estilos (los que se usan en anime y
  karaoke), SRT, WebVTT y PGS de Blu-ray, incluidas las pistas de subtítulos y las fuentes
  guardadas dentro de archivos MKV.
- **Cambiar de aspecto.** Incluye tres temas, y puedes crear el tuyo con un pequeño archivo JSON.
- **Manejarse con el teclado.** Los mismos atajos que mpv: avance fotograma a fotograma, control
  de velocidad, retardo de subtítulos, bucle A-B y más.
- **Enseñar lo que pasa por dentro.** Pulsa `i` para abrir un panel de estadísticas en directo.

| Modern Glass | mpv OSC (con estadísticas) | Studio Deck |
| --- | --- | --- |
| ![Tema Modern Glass](../screenshots/skin-glass.png) | ![Tema mpv OSC](../screenshots/skin-mpv.png) | ![Tema Studio Deck](../screenshots/skin-studio.png) |

## Antes de empezar

Necesitas tener instaladas tres cosas:

1. **Node.js 22 o posterior** (también sirve 20.19 o superior): descárgalo de
   [nodejs.org](https://nodejs.org). Para comprobarlo, abre una terminal y ejecuta
   `node --version`.
2. **Git**: descárgalo de [git-scm.com](https://git-scm.com).
3. **Microsoft Edge o Google Chrome**, en una versión reciente. Lumen depende de funciones nuevas
   del navegador (WebCodecs, WebGPU), y estos son los dos navegadores con los que se prueba.

También necesitas unos 500 MB de espacio libre en disco para las dependencias y los vídeos de
ejemplo.

## Primeros pasos

Abre una terminal (en Windows: PowerShell o Windows Terminal) y ejecuta estos comandos de uno en
uno.

**1. Descarga el código**

```bash
git clone https://github.com/manb0fish/lumen-web-player.git
```

```bash
cd lumen-web-player
```

**2. Instala las dependencias** (tarda uno o dos minutos)

```bash
npm install
```

**3. Crea los vídeos de ejemplo** (opcional, pero así tendrás algo que reproducir enseguida)

```bash
npm run media
```

Esto genera unos 30 clips de prueba cortos en tu ordenador. No se descarga nada.

**4. Inicia el reproductor**

```bash
npm run dev
```

Ahora abre **<http://127.0.0.1:5173>** en Edge o Chrome. Verás el reproductor con una lista de
clips de ejemplo a la izquierda. Haz clic en cualquiera para reproducirlo.

Para detener el reproductor, vuelve a la terminal y pulsa `Ctrl+C`.

## Cómo usar el reproductor

- **Reproducir un archivo tuyo:** arrástralo sobre el reproductor o haz clic en el icono de la
  carpeta.
- **Añadir subtítulos:** arrastra un archivo `.ass`, `.srt`, `.vtt` o `.sup` sobre el reproductor.
  Los subtítulos incluidos en archivos MKV se detectan automáticamente; elige uno en el menú de
  subtítulos.
- **Cambiar el tema:** haz clic en el icono de la paleta o pulsa `K`.
- **Cambiar las opciones de calidad de imagen:** el icono de los controles deslizantes abre los
  ajustes de renderizador, escalado y filtros.
- **Ver detalles técnicos:** pulsa `i`.

### Atajos de teclado útiles

| Tecla | Qué hace |
| --- | --- |
| `Space` | Reproducir / pausar |
| `←` `→` | Retroceder / avanzar 5 segundos |
| `,` `.` | Retroceder / avanzar un fotograma |
| `[` `]` | Más lento / más rápido |
| `9` `0` | Bajar / subir el volumen |
| `m` | Silenciar |
| `z` `x` | Adelantar / retrasar los subtítulos |
| `v` | Mostrar / ocultar los subtítulos |
| `l` | Bucle entre dos puntos (pulsa en A, pulsa en B, pulsa otra vez para quitarlo) |
| `f` | Pantalla completa |
| `K` | Tema siguiente |
| `i` | Estadísticas |

La lista completa, y cómo cambiar los atajos, está en la [guía](../GUIDE.md#keyboard-shortcuts)
(en inglés).

## Problemas habituales

**`npm run media` dice que falta ffmpeg.**
El paquete auxiliar de ffmpeg no pudo ejecutar su instalador. Ejecuta estos dos comandos y vuelve
a intentarlo:

```bash
npm install-scripts approve ffmpeg-static
```

```bash
npm rebuild ffmpeg-static
```

Si el primer comando dice que no existe, tu versión de npm es anterior y no lo necesita:
ejecuta solo el segundo.

**La lista de ejemplos está vacía.**
Ejecuta `npm run media` y recarga la página.

**La página no carga.**
Comprueba que `npm run dev` sigue en marcha en la terminal y que la dirección es exactamente
`http://127.0.0.1:5173`.

**Aparece «Audio is blocked by the browser».**
Los navegadores no dejan que las páginas empiecen a sonar por su cuenta. Haz clic una vez en el
reproductor y pulsa reproducir.

**No funciona en Firefox ni en Safari.**
Por ahora, usa Microsoft Edge o Google Chrome. Son los navegadores en los que se desarrolla y se
prueba Lumen.

**Un archivo no se reproduce.**
Pulsa `i` para ver qué decodificador se eligió y por qué. Una limitación conocida: el FFmpeg
integrado no puede decodificar vídeo AV1, así que hace falta un navegador que admita AV1 por sí
mismo (las versiones actuales de Edge y Chrome lo hacen).

## Para desarrolladores

Lumen también es una biblioteca: un núcleo de reproducción sin interfaz y, encima, una interfaz
de usuario opcional.

```ts
import { Player, mountUI } from './src';

const player = new Player({ container });
mountUI(player, container, { skin: 'glass' });
await player.load(fileOrUrl, { autoplay: true });
player.command('seek 30 absolute');
```

Ejecuta las comprobaciones:

```bash
npm run lint
```

```bash
npm test
```

Más información (en inglés):

- [Guía](../GUIDE.md): opciones de URL, todos los atajos, cómo integrarlo, cómo crear temas y la
  batería de pruebas.
- [Arquitectura](../ARCHITECTURE.md): cómo funcionan la decodificación, el renderizado, la
  sincronización de audio y los subtítulos, y las decisiones de diseño que hay detrás.
- [Verificación](../VERIFICATION.md): qué miden las 163 pruebas automatizadas y sus resultados.

## Autores

- [manb0fish](https://github.com/manb0fish)
- [Claude](https://claude.com/claude-code), el modelo de IA de Anthropic: coautor del código, las
  pruebas y la documentación

## Licencia

Lumen Player es software libre y se publica bajo la
[Licencia Pública General de GNU v3.0](../../LICENSE).

Se apoya en otros proyectos de código abierto que conservan sus propias licencias, entre ellos
[FFmpeg](https://ffmpeg.org) (a través de `@ffmpeg/core`, GPL),
[libass](https://github.com/libass/libass) (a través de JASSUB, LGPL y otras) y
[Mediabunny](https://mediabunny.dev) (MPL-2.0).
