# Collab Room : faire de la musique à plusieurs dans Ableton Live, en direct

Collab Room te permet de travailler **à plusieurs sur le même projet Live, chacun chez soi**. Quand ton pote ajoute une note, change un son ou renomme une piste, ça apparaît dans ton Live en moins d'une seconde. Et inversement.

C'est **gratuit**. Pas de compte à créer, pas d'abonnement : juste un petit fichier à installer dans Live.

---

## 1. Ce qu'il te faut

- **Ableton Live 12 Suite.** Les Extensions ne marchent pas avec Standard, Intro ou Lite.
- **La version bêta de Live 12.4.** Elle est gratuite pour les possesseurs de Live 12 Suite, et elle s'installe **à côté** de ton Live habituel, sans le remplacer :
  1. Va sur [ableton.com/beta](https://www.ableton.com/beta/) et inscris-toi au programme bêta avec ton compte Ableton.
  2. Sur la page de téléchargement qu'on te donne, prends **Live 12 Beta** et installe-le comme un Live normal.
- **Internet.**

Tout le monde dans la session doit avoir tout ça.

---

## 2. Installer Collab Room (2 minutes, une seule fois)

1. **Télécharge** le fichier `Collab-Room-….ablx` sur la [page des versions](https://github.com/alexandrelesage01-bot/collab-room/releases/latest) (sous « Assets »).
2. Ouvre **Live 12 Beta**, puis les **Réglages** (`⌘ ,` sur Mac, `Ctrl ,` sur Windows), onglet **Extensions**.
3. **Glisse le fichier** `.ablx` sur cette page, puis confirme.
4. Vérifie que **Developer Mode est désactivé** (il ne sert qu'aux développeurs).

C'est installé. Pour vérifier : **clic droit sur le nom d'une piste**, puis **Extensions → Collab Room**.

---

## 3. Lancer une session (celui qui invite)

1. Ouvre le projet que tu veux partager.
2. Clic droit sur le nom d'une piste → **Extensions → Collab Room → Collab Room…**
3. Écris ton prénom (c'est ce que les autres verront), puis clique **Créer une session**.
4. Un code comme **`K7M-Q2P`** s'affiche, et il est **déjà copié**. Colle-le à tes potes (WhatsApp, Discord, SMS…).

## 4. Rejoindre une session (les invités)

1. **Copie le code** qu'on t'a envoyé.
2. Dans Live Beta, ouvre un **projet vide** (`⌘ N` / `Ctrl N`).
3. Clic droit sur le nom d'une piste → **Extensions → Collab Room → Collab Room…**
4. Le code est déjà rempli : clique **Rejoindre**.

Le projet de ton pote arrive dans ton Live. Vous pouvez produire.

---

## 5. Pendant la session

Chacun travaille normalement dans son Live : tout se synchronise tout seul.

La fenêtre **Collab Room…** montre :

- le code de la session (bouton **Copier**) ;
- **qui est là** ;
- **ce que font les autres**, en direct (« Victor a modifié un clip de Bass ») ;
- **Synchroniser maintenant**, si tu as un doute ;
- **Quitter la session**. Ton projet reste tel quel chez toi.

### Ce qui se partage

| ✅ Partagé | ❌ Pas encore |
|---|---|
| Le tempo | L'automation |
| Les pistes MIDI et audio : nom, volume, pan, mute, solo | Les pistes de groupe et de retour |
| Les clips MIDI et leurs notes (Session et Arrangement) | Les clips audio de la vue **Session** |
| Les clips audio de l'**Arrangement** (jusqu'à 2 min 30 par clip) | Le routing |
| Les instruments et effets **d'Ableton** et tous leurs réglages | Le son interne des **plugins** (VST/AU) |

### Bon à savoir

- **Plugins (VST/AU) :** tout le monde doit avoir les mêmes. Les réglages suivent, mais un plugin absent chez quelqu'un ne peut pas être ajouté chez lui.
- **Audio :** seuls les clips audio de l'**Arrangement** se partagent, pas ceux de la vue Session. Chaque clip est envoyé tel qu'on l'entend, comme un « bounce », avant les effets de la piste. Il arrive quelques secondes après les notes : c'est normal. S'il est warpé chez toi, il arrive « figé » au tempo actuel. **2 min 30 maximum par clip** : coupe les clips plus longs en morceaux.
- **Deux personnes qui touchent la même chose en même temps :** la dernière modif gagne, et tout le monde finit avec le même résultat.
- **Changer de projet pendant une session** met la session **en pause**, sans rien effacer chez les autres. Rouvre le bon projet puis clique **Synchroniser maintenant**, ou **quitte** la session.
- **Pense à sauvegarder.** Chacun garde sa propre copie du projet. Pour la retrouver plus tard : rouvre-la, puis **rejoins** la même session avec le même code. Rien n'est dupliqué.

---

## 6. En cas de souci

| Ce que tu vois | Ce qu'il faut faire |
|---|---|
| **Collab Room n'apparaît pas** dans le clic droit | Fais le clic droit sur le **nom** d'une piste. Vérifie que **Developer Mode** est **désactivé** dans Réglages → Extensions, puis relance Live. |
| « **The Ableton extension has stopped running** » | Télécharge la dernière version de Collab Room et réinstalle-la (glisse-la à nouveau dans Réglages → Extensions). Si ça revient, signale-le (voir plus bas). |
| « **La session … n'existe pas ou est vide** » | Le code est faux, ou la personne qui invite a quitté la session. Redemande le code. |
| Un **clip audio** n'arrive pas | Attends quelques secondes. Seuls les clips de l'**Arrangement** se partagent (pas ceux de la vue Session), et chacun doit durer **2 min 30 au maximum**. |
| Un **plugin** manque | La personne doit installer le même plugin. |
| La fenêtre dit « **synchro manuelle** » | Clique **Synchroniser maintenant** de temps en temps. |

**Signaler un problème :** ouvre un ticket sur la [page du projet](https://github.com/alexandrelesage01-bot/collab-room/issues). Dis ce que tu faisais, et joins si possible le fichier `ExtensionHost.txt`. Sur Mac, il se trouve dans `~/Library/Preferences/Ableton/Live 12.4…/`.

---

## 7. Vie privée

- Ce qui passe par le serveur : le contenu de la session (notes, noms, réglages, rendus audio des clips de l'Arrangement), pour que les autres le reçoivent.
- **Toute personne qui a le code** peut rejoindre la session. Ne le partage qu'avec les gens avec qui tu produis.
- Le serveur tourne sur Cloudflare, dans l'offre gratuite. Si beaucoup de monde l'utilise le même jour, il peut atteindre sa limite quotidienne et ne repartir que le lendemain.
