# Collab Room

> 🎹 **Tu es musicien et tu veux juste l'utiliser ?** Suis le **[tutoriel](TUTORIEL.md)** : installation en 2 minutes, rien à configurer.
> Le fichier à installer est sur la **[page des versions](https://github.com/alexandrelesage01-bot/collab-room/releases/latest)**.
>
> La suite de cette page s'adresse aux développeurs.

Produire à plusieurs sur **le même Set Ableton Live, en direct**. Chacun travaille dans son Live. Les notes, clips, pistes, devices et réglages des autres arrivent chez toi en une fraction de seconde.

Tout passe par une **Extension Live** (le SDK d'Extensions de Live 12.4). Rien à installer à part un fichier `.ablx`. Pas de Max for Live, pas de plugin, pas d'appli à côté.

## Comment on s'en sert

Clic droit sur une piste → *Extensions* → **Collab Room…** ouvre la fenêtre.

1. **Toi** : tape ton nom, puis **Créer une session**. La fenêtre affiche un code du genre `K7M-Q2P`, déjà copié dans ton presse-papiers. Envoie-le à tes potes.
2. **Eux** : ils copient le code, ouvrent un **Set vide** et ouvrent la fenêtre. Le code y est déjà rempli, il reste à cliquer **Rejoindre**. Ton Set arrive chez eux.
3. Chacun produit. Les changements partent tout seuls (toutes les 0,5 s).

Pendant une session, la fenêtre montre le code, l'état de la connexion, **qui est là** et **l'activité en direct** (« Victor a modifié un clip de Bass »). On y trouve aussi les boutons *Synchroniser maintenant* et *Quitter la session* (ton Set reste tel quel). *Synchroniser maintenant* existe aussi directement dans le clic droit.

Tu rouvres le projet plus tard ? Rejoins la même session : les pistes sont reconnues par leur nom, rien n'est dupliqué.

## Ce qui est synchronisé

| Partagé | Pas (encore) partagé |
|---|---|
| Tempo, nombre de scènes | Automation, enveloppes de clips |
| Pistes MIDI et audio : nom, mute, solo, volume, pan | Pistes de groupe, pistes de retour, routing |
| Clips de session et d'arrangement : notes MIDI, nom, couleur, boucle, mute | Ordre des pistes (Live ne permet pas de les déplacer) |
| Clips audio de l'**Arrangement**, envoyés en rendu pré-effets (une fois, rangés par empreinte) | Clips audio de la vue **Session** (Live ne sait pas les rendre) |
| Devices natifs : ajout, suppression, ordre, tous les paramètres | État interne des plugins tiers (seuls leurs paramètres suivent) |

**Plugins tiers** : chacun doit avoir les mêmes. S'il en manque un chez quelqu'un, il reçoit un avertissement et le reste continue.

**Conflits** : si deux personnes changent *la même chose* au même moment (le même clip, le même réglage), la dernière modif arrivée au serveur gagne. Tout le monde finit avec le même résultat.

## Installation (une seule fois)

Il faut **Live 12 Suite**, en version **12.4.x bêta** (celle qui a les Extensions). On l'obtient via le programme bêta d'Ableton (Centercode).

### 1. Le serveur (une seule personne, gratuit)

C'est un petit Worker Cloudflare : une "salle" par session et un stockage pour les samples, le tout en Durable Objects. **Tout tient dans l'offre gratuite, sans moyen de paiement** : 5 Go de stockage, 100 000 écritures par jour. Il faut [Node.js](https://nodejs.org) (version LTS) et un compte Cloudflare gratuit.

```sh
cd ableton-collab
npm install
npx wrangler login
npm run server:deploy
```

Wrangler affiche l'adresse du serveur, par ex. `https://ableton-collab.toncompte.workers.dev`.

> Le serveur public tourne sur **https://ableton-collab.alexlesage.workers.dev**. Le `.ablx` de la page des versions l'utilise.

### 2. L'Extension

L'Extension est construite sur le **SDK officiel d'Ableton** (`@ableton-extensions/sdk`). Il ne se télécharge que via le programme bêta d'Ableton (Centercode, rubrique *Extensions SDK*), et sa licence interdit de le redistribuer. Il n'est donc pas dans ce dépôt : chacun qui fabrique l'Extension le dépose lui-même.

1. Dans le zip du SDK, prends les fichiers `ableton-extensions-sdk-<version>.tgz` et `ableton-extensions-cli-<version>.tgz`, et dépose-les dans `vendor/`.
2. Puis :

```sh
npm install
npm run setup                                                # installe le SDK déposé dans vendor/
npm run package -- https://ableton-collab.toncompte.workers.dev
```

esbuild assemble l'Extension, le SDK et la fenêtre en un seul fichier, puis l'outil officiel d'Ableton (`ableton-extensions-cli package`) en fait le `.ablx`. Ça produit `release/Collab-Room-0.1.0.ablx`. Envoie ce fichier à tes potes. Chacun l'installe en le **glissant sur la page Réglages → Extensions** de Live (12.4 bêta).

Chaque Extension a un fichier `config.json` dans son dossier de stockage. On peut y changer son nom affiché (`name`), le serveur (`server`), la cadence (`pollMs`) ou activer une notification à chaque modif reçue (`notifyChanges`).

## Comment ça marche

```
 Live d'Alex                    Cloudflare                     Live de Victor
┌───────────────────┐       ┌───────────────────────┐       ┌───────────────────┐
│ Extension         │  WS   │ Worker                │  WS   │ Extension         │
│ relit le Set      │◄─────►│  Durable Object       │◄─────►│ applique les      │
│ toutes les 0,5 s, │       │  = la salle K7M-Q2P   │       │ changements reçus │
│ envoie les diffs  │       │  (état + ordre)       │       │ et envoie les     │
└───────────────────┘       │  + samples (DO aussi) │       │ siens             │
                            └───────────────────────┘       └───────────────────┘
```

- L'API des Extensions ne prévient pas quand le Set change. L'Extension relit donc le Set régulièrement et le **met à plat** en clés (`song/tempo`, `t/<piste>/name`, `t/<piste>/s/<scène>` pour un clip de session, `t/<piste>/a/<clip>` pour un clip d'arrangement, `t/<piste>/d/<n>/p/<m>` pour un paramètre de device…). Elle compare avec le dernier état synchronisé et n'envoie que les différences.
- Le serveur numérote chaque changement et le renvoie à tout le monde, y compris à l'émetteur (ça lui sert d'accusé). Un changement reçu sur une clé qu'on vient soi-même de modifier est ignoré : notre version arrivera après au serveur et gagnera partout.
- En cas de coupure réseau, l'Extension se reconnecte toute seule. Ce que tu as fait hors ligne repart, et ce que les autres ont fait arrive.

Le code :

- `extension/src/extension.js` : l'Extension. Tout l'accès à Live passe par le SDK officiel (`initialize`, `song.tracks`, `clip.notes`, `track.insertDevice`…). Pour le réseau, elle utilise WebSocket et `fetch`, intégrés au Node de Live.
- `extension/ui/window.html` : la fenêtre. Live l'affiche dans une webview. Elle ne peut répondre à l'Extension qu'en se fermant (`close_and_send`) : chaque bouton la ferme avec une action, et l'Extension la rouvre si besoin. Pour afficher l'activité en direct, elle se connecte elle-même à la salle en observatrice.
- `server/src/room-core.js` : la logique d'une salle.
- `server/src/index.js` : le Worker Cloudflare.
- `test/fake-live.js` : un faux Live en mémoire, pour tester sans Live.
- `test/fake-sdk.js` : un faux SDK qui reproduit l'API publique du SDK (d'après ses déclarations de types) par-dessus le faux Live, pour tester sans le SDK. `test/sdk.test.mjs` rejoue les scénarios avec le **vrai** SDK dès qu'il est installé.

## Tests

```sh
npm test                                   # 19 tests avec le faux SDK : rejoindre, modifs croisées, conflits,
                                           # coupure réseau, relance de Live, devices, plugin absent, à trois…
                                           # + 3 tests avec le vrai SDK (sautés s'il n'est pas installé)
npm run server:dev                         # serveur local
npm run e2e -- http://localhost:8787       # deux faux Live via le vrai serveur (WebSocket + samples)
npm run e2e:window -- http://localhost:8787  # le parcours complet par la fenêtre : créer, rejoindre,
                                             # code faux, fenêtre observatrice
```

## À vérifier dans le vrai Live

Tout a été testé contre un faux Live et un faux SDK qui suit l'API publique du SDK. Le premier passage de `npm test` avec le vrai SDK installé confirmera le branchement. Trois points ne peuvent être confirmés que dans le vrai Live :

1. **La synchro automatique tourne-t-elle entre deux commandes ?** Ableton décrit les Extensions comme des actions ponctuelles. Si Live bloque les accès au Set en dehors d'une commande, l'Extension passe d'elle-même en **mode manuel** et prévient : on lance alors **Synchroniser maintenant**.
2. **`track.insertDevice(nom, position)`** : on suppose qu'il accepte le nom d'un device natif (« EQ Eight », « Utility »…).
3. **La fenêtre** : elle suit le protocole documenté du SDK (`showModalDialog` + `close_and_send`), mais n'a été vue que dans Firefox, pas dans la webview de Live. Il reste aussi à vérifier que sa connexion directe au serveur y est autorisée. Sinon, la liste des participants reste celle connue à l'ouverture et l'activité ne s'affiche pas.

## Limites connues

- **Live donne un nouveau handle à une piste déplacée**, et à tout quand on ouvre un autre Set. L'Extension retrouve les pistes par type et nom, et les clips par position. Si plus aucune piste de la session n'est là (autre Set ouvert), la session se met **en pause** sans rien envoyer. *Synchroniser maintenant* la relance une fois le bon Set rouvert.
- **Bac à sable** : dans Live, une Extension ne peut lire que son dossier de stockage et son dossier temporaire (Node tourne avec `--permission`), et le contexte n'expose pas `WebSocket`. L'Extension embarque donc `ws`. Pour l'audio, elle demande à Live un rendu pré-effets de la zone du clip (`renderPreFxAudio`), l'envoie, et le destinataire l'importe dans son projet (`importIntoProject`). Un rendu se joue sans warp, au tempo du moment. La vue Session ne se rend pas : ses clips audio ne sont pas partagés.
- **Tester seul** : `node tools/robot.mjs` lance un faux collaborateur. Il attend qu'un code de session soit copié, rejoint la session, crée une piste avec Drift, change d'accord et raconte ce qu'il voit.

## Pistes pour la suite

- Historique des versions et retour en arrière (« revenir à hier soir »).
- Automation et enveloppes, dès que l'API les expose.
- Écoute commune en direct (flux audio du master), pour jouer ensemble sur la même boucle.
