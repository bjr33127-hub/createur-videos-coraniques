# Quran Video Maker

Lecteur Quran local dans Electron.

## Utilisation

1. Installer les dépendances:

`npm install`

2. Lancer l'application:

`npm start`

3. Créer l'exécutable portable Windows:

`npm run build`

## Ce que fait maintenant le projet

- ouvre le lecteur directement dans une fenêtre Electron
- sert les fichiers du projet via un petit serveur local intégré
- conserve les données du lecteur (`qul`, `local_audio`, `online`, `sw.js`)

## Ce qui a été retiré

- enregistrement vidéo
- capture desktop
- FFmpeg et post-traitement
- workflow OBS
- scripts batch de lancement serveur

## Structure utile

- `index.html`: lecteur principal
- `electron/main.js`: fenêtre Electron + serveur local intégré
- `electron/preload.js`: indicateur minimal pour le runtime Electron
- `sw.js`: cache local

## Remarque

Le lecteur continue d'utiliser ses sources de données audio/traduction/timing existantes.
