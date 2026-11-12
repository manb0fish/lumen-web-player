<div align="center">

# Lumen Player

**Un lecteur vidéo puissant qui fonctionne entièrement dans votre navigateur.**

[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · **Français** · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md)

![Lumen Player avec l'habillage Modern Glass](../screenshots/skin-glass.png)

</div>

> Ce document est une traduction. En cas de divergence, le [README en anglais](../../README.md) fait foi.

## Qu'est-ce que Lumen ?

Lumen est un lecteur multimédia qui s'ouvre dans un onglet du navigateur. Imaginez un lecteur de
bureau comme mpv ou VLC, reconstruit avec les technologies web modernes. Vos fichiers ne quittent
jamais votre ordinateur : tout est décodé et affiché localement, dans la page.

Ce qu'il sait faire :

- **Lire presque tout.** Fichiers MP4, MKV, WebM, MPEG-TS, AVI et FLV ; vidéo H.264, HEVC, VP9,
  AV1 et formats plus anciens ; audio AAC, Opus, MP3, AC-3 et FLAC. Quand le navigateur ne peut
  pas décoder un fichier lui-même, Lumen bascule sur une copie intégrée de FFmpeg.
- **Rester fluide et synchronisé.** La vidéo est décodée par le matériel graphique quand c'est
  possible et dessinée par le GPU ; l'image reste calée sur le son à quelques millisecondes près.
- **Afficher correctement les sous-titres.** Sous-titres ASS/SSA stylisés (ceux des animés et du
  karaoké), SRT, WebVTT et PGS de Blu-ray, y compris les pistes de sous-titres et les polices
  embarquées dans les fichiers MKV.
- **Changer d'apparence.** Trois habillages sont fournis, et vous pouvez créer le vôtre avec un
  petit fichier JSON.
- **Se piloter au clavier.** Les mêmes raccourcis que mpv : avance image par image, vitesse de
  lecture, décalage des sous-titres, boucle A-B, etc.
- **Montrer ce qui se passe à l'intérieur.** Appuyez sur `i` pour ouvrir un panneau de
  statistiques en direct.

| Modern Glass | mpv OSC (avec statistiques) | Studio Deck |
| --- | --- | --- |
| ![Habillage Modern Glass](../screenshots/skin-glass.png) | ![Habillage mpv OSC](../screenshots/skin-mpv.png) | ![Habillage Studio Deck](../screenshots/skin-studio.png) |

## Avant de commencer

Trois choses doivent être installées :

1. **Node.js 22 ou plus récent** (20.19 ou plus fonctionne aussi) : à télécharger sur
   [nodejs.org](https://nodejs.org). Pour vérifier, ouvrez un terminal et lancez
   `node --version`.
2. **Git** : à télécharger sur [git-scm.com](https://git-scm.com).
3. **Microsoft Edge ou Google Chrome**, dans une version récente. Lumen s'appuie sur des
   fonctionnalités récentes des navigateurs (WebCodecs, WebGPU), et ce sont les deux navigateurs
   avec lesquels il est testé.

Il vous faut aussi environ 500 Mo d'espace disque libre pour les dépendances et les vidéos
d'exemple.

## Premiers pas

Ouvrez un terminal (sous Windows : PowerShell ou Windows Terminal) et lancez ces commandes une
par une.

**1. Téléchargez le code**

```bash
git clone https://github.com/manb0fish/lumen-web-player.git
```

```bash
cd lumen-web-player
```

**2. Installez les dépendances** (une à deux minutes)

```bash
npm install
```

**3. Créez les vidéos d'exemple** (facultatif, mais vous aurez tout de suite quelque chose à lire)

```bash
npm run media
```

Cette commande génère une trentaine de courts clips de test sur votre ordinateur. Rien n'est
téléchargé.

**4. Démarrez le lecteur**

```bash
npm run dev
```

Ouvrez maintenant **<http://127.0.0.1:5173>** dans Edge ou Chrome. Le lecteur s'affiche, avec la
liste des clips d'exemple à gauche. Cliquez sur l'un d'eux pour le lire.

Pour arrêter le lecteur, revenez au terminal et appuyez sur `Ctrl+C`.

## Utiliser le lecteur

- **Lire un de vos fichiers :** faites-le glisser sur le lecteur, ou cliquez sur l'icône du
  dossier.
- **Ajouter des sous-titres :** faites glisser un fichier `.ass`, `.srt`, `.vtt` ou `.sup` sur le
  lecteur. Les sous-titres contenus dans les fichiers MKV sont détectés automatiquement ;
  choisissez-en un dans le menu des sous-titres.
- **Changer d'habillage :** cliquez sur l'icône de la palette, ou appuyez sur `K`.
- **Régler la qualité d'image :** l'icône des curseurs ouvre les réglages du moteur de rendu, de
  la mise à l'échelle et des filtres.
- **Voir les détails techniques :** appuyez sur `i`.

### Raccourcis clavier utiles

| Touche | Action |
| --- | --- |
| `Space` | Lecture / pause |
| `←` `→` | Reculer / avancer de 5 secondes |
| `,` `.` | Reculer / avancer d'une image |
| `[` `]` | Ralentir / accélérer |
| `9` `0` | Baisser / monter le volume |
| `m` | Couper le son |
| `z` `x` | Avancer / retarder les sous-titres |
| `v` | Afficher / masquer les sous-titres |
| `l` | Boucle entre deux points (appuyez en A, puis en B, puis encore une fois pour l'annuler) |
| `f` | Plein écran |
| `K` | Habillage suivant |
| `i` | Statistiques |

La liste complète, et la façon de modifier les raccourcis, se trouvent dans le
[guide](../GUIDE.md#keyboard-shortcuts) (en anglais).

## Problèmes courants

**`npm run media` indique que ffmpeg est introuvable.**
Le paquet auxiliaire ffmpeg n'a pas pu exécuter son script d'installation. Lancez ces deux
commandes, puis réessayez :

```bash
npm install-scripts approve ffmpeg-static
```

```bash
npm rebuild ffmpeg-static
```

Si la première commande est signalée comme inconnue, votre version de npm est plus ancienne et
n'en a pas besoin : lancez seulement la seconde.

**La liste d'exemples est vide.**
Lancez `npm run media`, puis rechargez la page.

**La page ne se charge pas.**
Vérifiez que `npm run dev` tourne toujours dans le terminal et que l'adresse est exactement
`http://127.0.0.1:5173`.

**Le message « Audio is blocked by the browser » s'affiche.**
Les navigateurs n'autorisent pas une page à émettre du son toute seule. Cliquez une fois sur le
lecteur, puis lancez la lecture.

**Cela ne fonctionne pas dans Firefox ou Safari.**
Pour l'instant, utilisez Microsoft Edge ou Google Chrome : ce sont les navigateurs sur lesquels
Lumen est développé et testé.

**Un fichier refuse de se lire.**
Appuyez sur `i` pour voir quel décodeur a été choisi et pourquoi. Une limite connue : le FFmpeg
intégré ne sait pas décoder la vidéo AV1 ; il faut donc un navigateur qui prenne lui-même en
charge l'AV1 (c'est le cas des versions actuelles d'Edge et de Chrome).

## Pour les développeurs

Lumen est aussi une bibliothèque : un cœur de lecteur sans interface, surmonté d'une interface
utilisateur facultative.

```ts
import { Player, mountUI } from './src';

const player = new Player({ container });
mountUI(player, container, { skin: 'glass' });
await player.load(fileOrUrl, { autoplay: true });
player.command('seek 30 absolute');
```

Lancer les vérifications :

```bash
npm run lint
```

```bash
npm test
```

Pour aller plus loin (en anglais) :

- [Guide](../GUIDE.md) : options d'URL, tous les raccourcis, intégration dans une page, création
  d'habillages, suite de tests.
- [Architecture](../ARCHITECTURE.md) : fonctionnement du décodage, du rendu, de la
  synchronisation audio et des sous-titres, et les compromis retenus.
- [Vérification](../VERIFICATION.md) : ce que mesurent les 163 tests automatisés, et leurs
  résultats.

## Auteurs

- [manb0fish](https://github.com/manb0fish)
- [Claude](https://claude.com/claude-code), le modèle d'IA d'Anthropic : co-auteur du code, des
  tests et de la documentation

## Licence

Lumen Player est un logiciel libre, publié sous la
[licence publique générale GNU v3.0](../../LICENSE).

Il s'appuie sur d'autres projets open source qui conservent leurs propres licences, notamment
[FFmpeg](https://ffmpeg.org) (via `@ffmpeg/core`, GPL),
[libass](https://github.com/libass/libass) (via JASSUB, LGPL entre autres) et
[Mediabunny](https://mediabunny.dev) (MPL-2.0).
