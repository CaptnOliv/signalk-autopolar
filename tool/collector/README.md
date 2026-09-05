# Collecteur de polaires

Reçoit ce que `signalk-autopolar` reverse (`shareEndpoint`, par défaut
`https://polars.quicky.app/v1/polars`). Sans dépendance, sans base de données,
sans secret : les données qui arrivent ne contiennent aucune position, donc il
n'y a rien à protéger — seulement à conserver.

```
POST /v1/polars   → { ok: true }        corps = la charge utile du plugin
GET  /health      → { ok: true }
```

Une soumission écrase la précédente du même bateau (`<modèle>/<nom>.json` et
`.pol`), et `log.jsonl` garde la trace de tous les envois — assez pour voir une
régression du plugin, pas assez pour reconstituer quoi que ce soit.

## Déploiement sur quickyng

```bash
docker build -t polars-collector tool/collector/
docker run -d --name polars \
  --network veille-net \
  -v /home/oliv/containers/polars/data:/data \
  -e VIRTUAL_HOST=polars.quicky.app \
  -e VIRTUAL_PORT=8080 \
  -e LETSENCRYPT_HOST=polars.quicky.app \
  polars-collector
```

Il faut l'enregistrement DNS `polars.quicky.app` avant de lancer le conteneur,
sinon acme-companion échoue sur le challenge et le certificat n'est pas émis.
