# Collecteur de polaires

Reçoit ce que `signalk-autopolar` reverse (`shareEndpoint`, par défaut
`https://autopolar.quicky.app/v1/polars`) et compte les installations. Sans
dépendance, sans base de données, sans secret : les données qui arrivent ne
contiennent aucune position, donc il n'y a rien à protéger — seulement à
conserver.

```
POST /v1/polars   → { ok: true }   la polaire d'un bateau
POST /v1/ping     → { ok: true }   « cette installation existe », 1×/jour
GET  /v1/stats    → le compte, en lecture publique
GET  /health      → { ok: true }
```

## Qui écrase quoi

La clé est l'`installId` tiré une fois par le plugin, **pas le nom du bateau**.
Deux Oceanis 48 dont les propriétaires écrivent tous les deux « Jazzy »
s'écrasaient l'un l'autre en silence ; et un bateau qui changeait de
`shareName` laissait un doublon orphelin derrière lui au lieu de remplacer sa
propre polaire.

Les fichiers gardent quand même un chemin lisible (`<modèle>/<nom>.json` et
`.pol`) — il faut pouvoir fouiller le fonds à la main — mais c'est
l'identifiant qui fait autorité : un homonyme est rangé sous
`<nom>-<6 caractères>`, et un bateau renommé voit sa polaire déplacée, pas
dupliquée.

Les envois **sans identifiant** (plugins ≤ 0.6.1) restent acceptés et gardent
l'ancien comportement. Ils ne comptent dans aucune statistique, faute de savoir
à quelle installation les rattacher.

`log.jsonl` garde la trace de tous les envois — assez pour voir une régression
du plugin, pas assez pour reconstituer quoi que ce soit. `installs.json` tient
le registre des installations connues.

**Aucune adresse IP n'est conservée, nulle part.** C'est ce qui permet
d'annoncer le ping franchement côté plugin au lieu de le déguiser en test de
connectivité.

## Notifications ntfy

Une notification part à chaque polaire reçue, la vôtre comprise : c'est le seul
moyen de voir le fonds vivre sans aller regarder. Le titre distingue une
première polaire d'une mise à jour, le corps donne le bateau, le nombre de
points, de cases et de bandes de vent, plus le total du fonds.

Deux envois du même bateau à moins de dix minutes d'intervalle, c'est quelqu'un
qui essaie le bouton « send now » : la polaire est gardée, mais on n'en notifie
qu'une. Une notification qui échoue ne coûte jamais la polaire — celle-ci est
déjà sur le disque quand ntfy est appelé.

Les noms de bateaux et de modèles sont du texte libre venu d'inconnus, donc ils
finiront par contenir un accent, un tiret cadratin ou un emoji. Une valeur
d'en-tête HTTP est une ByteString : un seul caractère hors Latin-1 et `fetch`
lève « Cannot convert argument to a ByteString ». Les titres non-ASCII sont
donc encodés en RFC 2047, que ntfy sait décoder.

| variable | rôle |
|---|---|
| `NTFY_URL` | l'URL du topic, par exemple `https://ntfy.quicky.app/jazzy`. Vide = pas de notification |
| `NTFY_TOKEN` | jeton `Bearer`, si le serveur en demande un |
| `NTFY_NEW_INSTALLS` | `1` pour être aussi prévenu à chaque nouvelle installation, tous plugins confondus (pas seulement à chaque polaire). Le titre dit de quel plugin il s'agit. Coupé par défaut |

## Statistiques

`GET /v1/stats` est public et ne contient **aucun nom de bateau** : un compteur
n'en a pas besoin, et cette route n'est protégée par rien.

```json
{
  "installs": 12, "active30d": 9, "active7d": 7,
  "sharing": 10, "polars": 6,
  "plugins": [
    { "plugin": "signalk-autopolar", "installs": 8, "active30d": 7,
      "active7d": 6, "sharing": 8, "polars": 6, "versions": { "0.7.0": 8 } },
    { "plugin": "signalk-ac42-autopilot", "installs": 4, "active30d": 2,
      "active7d": 1, "sharing": 0, "polars": 0, "versions": { "1.2.0": 4 } }
  ],
  "models": [{ "model": "Beneteau Oceanis 48", "boats": 2, "points": 1380 }],
  "firstSeen": "2026-09-08T10:00:00.000Z"
}
```

`installs` compte les installations qui se sont signalées au moins une fois,
`polars` celles qui ont effectivement reversé une polaire — l'écart entre les
deux est le nombre de bateaux qui font tourner le plugin sans partager.

**Plusieurs plugins pointent sur ce collecteur** (`signalk-ac42-autopilot` y
envoie aussi son ping, sous le même nom de domaine pour l'instant). D'où le
détail par plugin : mélanger les comptes ne dirait rien de personne, et deux
plugins peuvent parfaitement porter le même numéro de version. Une polaire
reçue sans champ `plugin` est attribuée à `signalk-autopolar`, seul plugin qui
en reverse.

## Tests

```bash
node test.js
```

Un vrai serveur sur un port éphémère, des requêtes HTTP réelles, ntfy bouchonné
(aucun accès réseau). Vérifie surtout qu'une polaire ne peut pas en écraser une
autre et qu'un nom accentué ne gèle pas les notifications.

## Déploiement sur quickyng

Les sources vivent dans `/home/oliv/containers/polars/src/` sur quickyng, et la
configuration dans `/home/oliv/containers/polars/polars.env` (mode 600 — il
contient le jeton ntfy, qui n'a rien à faire dans une ligne de commande ni dans
l'historique du shell) :

```
VIRTUAL_HOST=autopolar.quicky.app
VIRTUAL_PORT=8080
LETSENCRYPT_HOST=autopolar.quicky.app
POLARS_DIR=/data
PORT=8080
NTFY_URL=https://ntfy.quicky.app/jazzy
NTFY_TOKEN=…
NTFY_NEW_INSTALLS=1
```

```bash
# depuis le Mac ou JazzyPI (les deux ont une clé SSH vers quickyng)
scp tool/collector/{server.js,Dockerfile,README.md,test.js} quickyng:/home/oliv/containers/polars/src/
ssh quickyng '
  cd /home/oliv/containers/polars/src && node test.js || exit 1
  docker tag polars-collector polars-collector:prev   # de quoi revenir en arrière
  docker build -t polars-collector .
  docker rm -f polars
  docker run -d --name polars --restart unless-stopped \
    --network veille-net \
    --env-file /home/oliv/containers/polars/polars.env \
    -v /home/oliv/containers/polars/data:/data \
    polars-collector'
curl -s https://autopolar.quicky.app/v1/stats
```

On construit et on teste **avant** de détruire le conteneur en service : un
`docker rm -f` suivi d'un build qui échoue laisserait le service à terre.
`polars-collector:prev` garde l'image précédente sous la main.

Il faut l'enregistrement DNS `autopolar.quicky.app` avant le tout premier
lancement, sinon acme-companion échoue sur le challenge et le certificat n'est
pas émis.

Le volume `/data` survit à tout ça, donc le registre et les polaires aussi.
Sauvegarde à la main avant une mise à jour :
`cp -a /home/oliv/containers/polars/data /home/oliv/containers/polars/data.bak-$(date +%Y%m%d-%H%M%S)`.

**Les fichiers de `/data` appartiennent à root** (le conteneur tourne en root) :
pour en retirer un depuis quickyng, passer par
`docker exec polars rm …` plutôt que d'essayer en tant qu'`oliv`.
