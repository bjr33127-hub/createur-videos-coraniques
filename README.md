# Quran Video Maker

Guide simple en francais pour lancer l'application, choisir un recitateur, regler l'affichage et enregistrer proprement avec OBS.

## 1. A quoi sert cette application

Cette application affiche le Coran dans une fenetre Electron avec :

- le texte arabe
- une traduction
- des styles visuels
- plusieurs types de recitateurs
- une integration avec OBS pour enregistrer le rendu

L'application sert a preparer le visuel et l'audio.
La video finale, elle, se fait dans OBS.

## 2. Ce qu'il faut avant de commencer

Pour utiliser l'application :

- Windows 10 ou Windows 11
- soit le fichier `.exe`
- soit Node.js si vous lancez le projet depuis les sources

Pour enregistrer :

- OBS Studio

Pour certaines recitations :

- Internet pour les recitateurs MP3Quran
- Internet pour certaines traductions

## 3. Comment lancer l'application

### Methode la plus simple : utiliser le .exe

Ouvrez le fichier :

`dist/QuranVideoMaker 1.0.0.exe`

### Methode developpeur : lancer depuis le projet

Dans le dossier du projet :

```powershell
npm.cmd install
npm.cmd start
```

### Refaire le .exe

Si vous voulez regenerer l'application Windows :

```powershell
npm.cmd run build
```

Le nouveau `.exe` sera cree dans le dossier `dist/`.

## 4. Comprendre l'ecran principal

Au lancement, les reglages les plus importants sont :

- `Sourate` : la sourate a afficher
- `Verset` : le verset de depart
- `Recitateur` : la source audio
- `Traduction` : le texte en bas
- `Lecture / Pause` : lance ou coupe la lecture
- `Affichage avance` : ouvre les reglages visuels et OBS

Dans `Affichage avance`, les options les plus utiles sont :

- `Style texte`
- `Effet mot`
- `Style particules`
- `Separateur`
- `Mode epure`
- `Fond transparent`
- `Pre-telecharger`
- `Vider cache`
- `Auto REC OBS`
- `OBS WS`
- `Mot de passe`

## 5. Quel recitateur choisir

### Recitateurs QUL

A utiliser si vous voulez :

- le meilleur rendu visuel
- le meilleur suivi mot a mot
- une experience plus precise

C'est souvent le meilleur choix pour faire une belle video.

### Recitateurs MP3Quran

A utiliser si vous voulez :

- plus de choix de recitateurs
- une recitation en ligne sans preparer vos propres MP3

Attention :

- une connexion Internet est necessaire
- le comportement n'est pas exactement le meme que QUL

### Recitation locale personnalisee

L'option s'appelle :

`Custom recitation (1 MP3 / Ayah)`

Elle lit un fichier MP3 par verset avec cette structure :

```text
local_audio/
  custom_recitation/
    001/
      001.mp3
      002.mp3
      003.mp3
    002/
      001.mp3
      002.mp3
```

Important :

- le dossier de la sourate doit etre sur 3 chiffres
- le nom du MP3 du verset doit etre sur 3 chiffres

Exemples :

- sourate 1, verset 1 : `local_audio/custom_recitation/001/001.mp3`
- sourate 39, verset 7 : `local_audio/custom_recitation/039/007.mp3`

Si vous remplacez des MP3 locaux, pensez a cliquer sur `Vider cache`.

## 6. Premiere verification avant d'enregistrer

Avant de faire une vraie video, faites ce test :

1. Lancez l'application.
2. Choisissez une sourate courte.
3. Choisissez un recitateur.
4. Choisissez une traduction.
5. Ouvrez `Affichage avance`.
6. Reglez votre style visuel.
7. Cliquez sur `Pre-telecharger` si vous voulez eviter des coupures.
8. Lancez la lecture.
9. Verifiez que le son, le texte et les effets vous conviennent.

Ce petit test evite beaucoup de problemes pendant l'enregistrement.

## 7. Methode recommandee pour OBS

La methode conseillee dans ce projet est :

- `Mode epure` active
- `Fond transparent` active
- `Capture de fenetre` dans OBS

Cette methode est simple a comprendre et pratique pour les debutants.

## 8. Regler le mode transparent dans l'application

Faites ces etapes dans l'application :

1. Ouvrez `Affichage avance`.
2. Activez `Mode epure`.
3. Activez `Fond transparent`.
4. Choisissez votre `Style texte`.
5. Choisissez votre `Effet mot`.
6. Choisissez votre `Style particules`.
7. Choisissez votre `Separateur`.
8. Verifiez le rendu a l'ecran.

### A quoi sert `Mode epure`

`Mode epure` retire l'interface inutile pour ne garder que la scene utile a l'enregistrement.

### A quoi sert `Fond transparent`

`Fond transparent` rend le fond de la scene transparent au lieu d'afficher un bloc plein.

En pratique, cela permet d'avoir dans OBS un rendu plus propre, plus leger visuellement, et plus facile a integrer sur une scene.

## 9. Enregistrer avec OBS pas a pas

Voici la methode complete, simple et recommandee.

### Etape 1 : preparer l'application

1. Lancez l'application.
2. Choisissez la sourate.
3. Choisissez le verset de depart.
4. Choisissez le recitateur.
5. Ouvrez `Affichage avance`.
6. Activez `Mode epure`.
7. Activez `Fond transparent`.
8. Reglez le style visuel.
9. Cliquez sur `Pre-telecharger` si necessaire.

### Etape 2 : preparer OBS

1. Ouvrez OBS Studio.
2. Creez une nouvelle scene.
3. Cliquez sur `+` dans la liste des sources.
4. Ajoutez une `Capture de fenetre`.
5. Donnez-lui un nom.
6. Choisissez la fenetre de l'application Quran Video Maker.
7. Validez.

### Etape 3 : ajuster le cadrage

Dans OBS :

1. Selectionnez la source de capture.
2. Etirez-la ou ajustez-la pour bien remplir votre scene.
3. Verifiez que le texte est net et bien centre.
4. Faites un test de lecture dans l'application.

### Etape 4 : lancer l'enregistrement

1. Dans OBS, cliquez sur `Demarrer l'enregistrement`.
2. Revenez dans l'application.
3. Cliquez sur `Lecture`.
4. Laissez la recitation se terminer.
5. Revenez dans OBS.
6. Cliquez sur `Arreter l'enregistrement`.

## 10. Utiliser Auto REC OBS

`Auto REC OBS` permet a l'application de demarrer et d'arreter OBS automatiquement.

Pour l'utiliser :

1. Ouvrez OBS.
2. Activez `obs-websocket`.
3. Gardez de preference le port `4455`.
4. Entrez l'adresse dans `OBS WS`.
5. Entrez le mot de passe si vous en avez mis un.
6. Cochez `Auto REC OBS`.

Important :

- faites d'abord un test manuel
- si un batch est lance, l'application peut enchainer plusieurs sourates
- verifiez toujours vos reglages avant de lancer un enregistrement long

## 11. Conseils pour un rendu propre

- utilisez une sourate courte pour vos premiers essais
- testez toujours une lecture complete avant un vrai record
- utilisez un recitateur QUL si vous voulez le meilleur effet mot a mot
- utilisez `Pre-telecharger` avant un enregistrement important
- gardez OBS ouvert avant de lancer la lecture
- evitez de modifier les reglages au milieu d'un enregistrement

## 12. Problemes frequents

### Le son ne part pas

- verifiez le recitateur choisi
- testez une autre sourate
- verifiez votre connexion si vous utilisez MP3Quran
- utilisez `Pre-telecharger`

### Le texte s'affiche mais pas comme voulu

- ouvrez `Affichage avance`
- verifiez `Mode epure`
- verifiez `Fond transparent`
- essayez un autre `Style texte` ou un autre `Effet mot`

### OBS ne capture pas la bonne fenetre

- supprimez la source
- recréez une `Capture de fenetre`
- selectionnez de nouveau la fenetre Quran Video Maker

### Les MP3 locaux ne changent pas

- cliquez sur `Vider cache`
- verifiez les noms de dossiers et de fichiers
- utilisez bien des noms sur 3 chiffres

## 13. Resume ultra court

Si vous voulez aller vite :

1. Lancez le `.exe`
2. Choisissez la sourate et le recitateur
3. Ouvrez `Affichage avance`
4. Activez `Mode epure`
5. Activez `Fond transparent`
6. Reglez le style
7. Ouvrez OBS
8. Ajoutez une `Capture de fenetre`
9. Demarrez l'enregistrement dans OBS
10. Lancez la lecture dans l'application

C'est le parcours le plus simple pour commencer.
