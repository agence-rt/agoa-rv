# AGOA PV

> Dépôt `agoa-rv` (nom d'origine de l'application, conservé pour les mises à jour).

Application Windows de suivi de chantier et de rédaction des procès-verbaux de réunion
(SELARL Rémi Thollet Architecte / Thomas Kochanski Architecte).

## Installer

Télécharger `AGOA-PV-Setup-x.y.z.exe` dans la dernière
[Release](https://github.com/agence-rt/agoa-rv/releases/latest) et le lancer.
L'assistant (en français) s'ouvre sur une page d'accueil qui annonce les étapes, puis demande :
- pour qui installer : l'utilisateur courant (sans droits administrateur) ou tous les utilisateurs du poste ;
- le **dossier d'installation** (modifiable, par défaut `%LOCALAPPDATA%\Programs\agoa-rv`).

Les mises à jour automatiques s'installent dans le même dossier, sans repasser par l'assistant.
Pour changer de dossier ensuite, relancer l'installateur téléchargé (ou désinstaller puis réinstaller).
Les données (`%APPDATA%\AGOA PV`) ne sont pas supprimées à la désinstallation.

Au premier lancement : **Options › Connexion Ragic** (bouton « Options » en bas à gauche, ou onglet Options d'un dossier), renseigner la clé API Ragic
(le serveur `https://eu2.ragic.com` est prérempli). La clé reste sur le poste (`%APPDATA%\AGOA PV\agoa-rv-config.json`),
elle n'est jamais envoyée sur GitHub.

**Assistant de rédaction (IA)** : la baguette magique de la barre de mise en forme reformule un texte. Sur Windows, elle utilise une clé API Anthropic
à saisir dans **Options › Assistant de rédaction (IA)** (facturée sur ce compte API, stockée sur le poste). Dans la version Claude, aucune clé n'est nécessaire.

## Mises à jour

Au lancement, pendant l'écran de démarrage « AGOA PV CHANTIER », l'application interroge
les Releases de ce dépôt (6 s au plus ; hors connexion, elle démarre normalement).
Si une version plus récente existe, l'écran l'indique, la télécharge (progression affichée),
l'installe puis relance AGOA PV, sans intervention. En cours d'utilisation,
**Options › Rechercher une mise à jour** propose la mise à jour.

## Accès réservé (identification Google)

Au premier lancement sur un poste, AGOA PV demande de se connecter avec Google (navigateur
par défaut). Seuls les comptes autorisés peuvent l'utiliser ; l'identification est ensuite
mémorisée, chiffrée par Windows pour la session de l'utilisateur.

Réglages dans `package.json` → `agoa.google` :
- `clientId` : client OAuth Google de type « Application de bureau » ; son code secret n'est pas
  dans ce dépôt : il est stocké dans le secret GitHub Actions `GOOGLE_CLIENT_SECRET` et injecté
  à la fabrication de l'installateur ;
- `allowed` : empreintes SHA-256 des adresses autorisées (en minuscules), pour ne pas publier
  les adresses en clair dans ce dépôt public.

Tant que `clientId` est vide, l'identification est désactivée.

## Données

- Base de travail : `%APPDATA%\AGOA PV\agoa-rv-donnees.json` (copie de secours `.bak`).
- Fichier du dossier : **`.pv`** (JSON, photos et plans inclus). À la création d'un dossier,
  l'application propose de l'enregistrer sur le disque ; ce fichier est ensuite mis à jour
  automatiquement à chaque modification. Un double-clic sur un `.pv` l'ouvre dans AGOA PV.
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
