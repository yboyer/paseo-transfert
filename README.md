# Paseo Transfert

Copiez ou déplacez un workspace Git entre deux hôtes Paseo.

Le plugin crée un nouveau dossier sur l’hôte de destination. Ce dossier contient un dépôt Git et un worktree. Le plugin enregistre ensuite ce worktree comme workspace Paseo.

## Installation

Prérequis sur les deux hôtes :

- Paseo **0.13.x** ;
- Node.js **22 ou plus récent** ;
- Git ;
- le plugin activé dans **Settings → Plugins**.

Exécutez sur chaque hôte :

```sh
paseo plugin add git:yboyer/paseo-transfert
```

Le plugin utilise les connexions enregistrées **sur le daemon source**. Une connexion visible uniquement dans votre application ne suffit pas. Connectez l’hôte de destination au daemon source avec les réglages de Paseo ou sa commande `paseo host add`. Le plugin ne demande pas de configuration SSH supplémentaire.

Les dépendances de transport sont installées avec `npm ci --omit=dev --ignore-scripts`. Paseo doit pouvoir accéder au registre npm lors de l’installation.

## Utilisation

1. Ouvrez le workspace source et cliquez sur **Transfert** dans son en-tête. Vous pouvez aussi utiliser la barre latérale ou le Command Center.
2. Sélectionnez l’hôte de destination.
3. Indiquez un dossier parent **existant sur cet hôte** et le nom d’un nouveau dossier.
4. Choisissez **Copier** ou **Déplacer**.
5. Vérifiez l’aperçu et confirmez la copie.
6. Pour déplacer le workspace, attendez la vérification, puis confirmez l’archivage de la source.

Exemple de destination :

```text
/Users/vous/Code/mon-projet-local/
├── repository.git/    # Dépôt Git avec l’historique
└── worktree/          # Code du workspace Paseo
```

Le dossier de destination doit être libre. Aucun dossier existant n’est écrasé. Un retour vers l’hôte initial utilise aussi un nouveau dossier. Les copies restent indépendantes.

## Contenu transféré

- Historique Git accessible depuis les références locales, branches, tags et HEAD.
- Fichiers suivis dans leur état actuel, y compris les suppressions.
- Modifications préparées pour commit, conservées séparément des autres modifications.
- Fichiers non suivis et non ignorés par Git.
- Fichiers binaires, permissions d’exécution et liens symboliques internes au projet.

Les fichiers ignorés par Git ne sont pas copiés. Cette exclusion concerne les fichiers actuels, **pas les versions déjà présentes dans l’historique Git**. L’aperçu liste les chemins inclus et les fichiers ou dossiers ignorés.

Les conversations, identifiants des fournisseurs, réglages MCP et configurations locales Git ne sont pas transférés. Le dépôt reçu n’a pas de remote configuré. Les fichiers de configuration suivis dans Git restent des fichiers du projet et sont copiés comme les autres.

## Copier et déplacer

**Copier** conserve la source.

**Déplacer** réalise d’abord la même copie. L’utilisateur confirme ensuite l’archivage dans Paseo. Le plugin vérifie à nouveau la source et la destination avant de demander cet archivage.

- Si Paseo gère le worktree source, son archivage peut supprimer ce worktree.
- Pour un checkout local ou un worktree créé par Transfert, l’archivage retire le workspace de Paseo et conserve les fichiers sur disque. Le plugin ne supprime pas directement ces dossiers.
- La présence de fichiers ou dossiers ignorés bloque le déplacement afin de prévenir leur perte.
- Il faut arrêter les agents et fermer les terminaux source avant l’archivage.

Arrêtez également les éditeurs, scripts ou autres programmes qui écrivent dans le projet pendant l’opération. Le plugin ne peut pas verrouiller les programmes externes.

## Contrôles et limites

Le transfert vérifie une somme SHA-256, l’état des fichiers restaurés et le contenu préparé pour commit. Il refuse les chemins dangereux, les liens symboliques externes, les collisions de casse et les destinations occupées.

Limites de la première version :

- Linux, macOS et WSL ; Windows natif n’est pas pris en charge.
- Workspace placé à la racine d’un checkout Git avec au moins un commit.
- Pas de submodules, de Git LFS ou de conflits Git non résolus.
- 20 000 fichiers au maximum et une archive de transfert de 128 MiB au maximum. L’archive inclut l’historique et les données encodées en base64.
- Pas de synchronisation automatique, de fusion avec une destination existante ou de reprise des conversations.
- Le nouveau worktree utilise une branche `transfert/<identifiant>`. Les références d’origine restent dans le dépôt reçu.
- Les hooks Git et les scripts de préparation du projet ne sont pas exécutés par le transfert.

Un aperçu expire après 15 minutes. Un changement de la source impose un nouvel aperçu. Le transfert continue si vous quittez l’écran, tant que les deux daemons et le plugin restent actifs.

L’identifiant de suivi permet de retrouver une opération sur le même hôte source pendant environ une heure. Le suivi et la confirmation d’archivage ne survivent pas au redémarrage du plugin. Les copies terminées restent sur disque.

En cas d’échec, la source reste intacte. Un dossier partiel peut rester à destination. Vérifiez son contenu avant de le retirer. Une nouvelle tentative utilise un nouveau dossier. Le transfert ne reprend pas automatiquement les morceaux déjà reçus.

## Développement

```sh
npm ci
npm run check
```

Essai complet avec deux daemons temporaires, sans utiliser vos hôtes habituels :

```sh
npm install --global @getpaseo/cli@0.13.0
npm run test:e2e
```

Cet essai installe le plugin, connecte les daemons, copie un vrai worktree, vérifie le workspace reçu, teste les refus d’archivage, puis archive un worktree source géré par Paseo.

Le transport Node de Paseo est isolé dans `server/connection.ts`. Il utilise l’identité locale du daemon et ses routes authentifiées. Le SDK ne fournit pas de méthode publique de RPC plugin entre hôtes. Le plugin utilise donc son client de bas niveau, fixé à la version 0.13.0. La plage Paseo reste limitée à 0.13.x jusqu’à vérification des versions suivantes.

Les tests automatisés couvrent le serveur et le transfert entre daemons. L’interface doit encore être vérifiée dans les clients Paseo desktop et mobile.
