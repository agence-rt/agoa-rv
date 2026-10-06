# AGOA RV

Application Windows de suivi de chantier et de rédaction des procès-verbaux de réunion
(SELARL Rémi Thollet Architecte / Thomas Kochanski Architecte).

## Installer

Télécharger `AGOA-RV-Setup-x.y.z.exe` dans la dernière
[Release](https://github.com/agence-rt/agoa-rv/releases/latest) et le lancer.
L'installation se fait pour l'utilisateur courant, sans droits administrateur.

Au premier lancement : **Agence › Connexion Ragic**, renseigner la clé API Ragic
(le serveur `https://eu2.ragic.com` est prérempli). La clé reste sur le poste (`%APPDATA%\AGOA RV\agoa-rv-config.json`),
elle n'est jamais envoyée sur GitHub.

## Mises à jour

L'application vérifie les Releases de ce dépôt à chaque démarrage, télécharge la nouvelle
version en arrière-plan et propose de redémarrer. Aucune réinstallation.

## Données

- Base de travail : `%APPDATA%\AGOA RV\agoa-rv-donnees.json` (copie de secours `.bak`).
- Fichier du dossier : **`.pv`** (JSON, photos et plans inclus). À la création d'un dossier,
  l'application propose de l'enregistrer sur le disque ; ce fichier est ensuite mis à jour
  automatiquement à chaque modification. Un double-clic sur un `.pv` l'ouvre dans AGOA RV.
  Les anciens fichiers `.agoarv` restent lisibles.

## Publier un déploiement

```
npm run deploy -- "Description de la mise à jour"
git push
```

Le script incrémente le numéro de déploiement, aligne la version (`0.<n>.0`), met à jour
`DEPLOIEMENTS.md` et crée le commit. Dès que la nouvelle version arrive sur `main`,
GitHub Actions fabrique l'installateur et publie la Release (étiquette `vX.Y.Z` comprise).

## Développement

```
npm install
npm start
```

L'interface est un fichier unique, `app/index.html`, identique à la version utilisable dans claude.ai.
