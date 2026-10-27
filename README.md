# rundom

Беговые маршруты по Москве и улицы, которые вы уже пробежали.

Всё считается в браузере: граф улиц OpenStreetMap и поиск пути A*. Личные данные (треки, настройки) хранятся
только на вашем устройстве.

## Разработка

```bash
npm install
npm run dev
npm test
npm run build
```

- `src/core/` — граф, правила проходимости, роутинг, генератор маршрутов, GPX (без DOM).
- `src/map/` — карта Leaflet и векторная подложка rundom (MapLibre, свои тайлы Москвы в PMTiles).
- `src/ui/` — вкладки «Маршрут», «Библиотека», «Прогресс», настройки, нижний лист на телефоне.
- `src/storage/` — хранение на устройстве.
- `src/data/` — запросы к Overpass и границы районов (`districts.json`).
- `scripts/build-districts.mjs` — пересборка границ районов из OSM: `npm run data:districts`.
- `scripts/data/` — данные покрытия улиц внутри МКАД. Сборка из выгрузки OSM:
  `npm run data:build -- Moscow.osm.pbf`. Можно вместо сборки скачать последний релиз: `npm run data:fetch`
  (нужен `gh`). Данные кладутся в `public/data/` и в git не попадают.
- `scripts/tiles/` — профиль tilemaker для тайлов подложки. Сборка (нужен Docker):
  `docker run --rm -v "$PWD":/w ghcr.io/systemed/tilemaker:master --input /w/Moscow.osm.pbf --output /w/public/data/moscow.pmtiles --config /w/scripts/tiles/config.json --process /w/scripts/tiles/process.lua --store /w/.cache/tm`.
  Релиз `data-YYYY-MM` уже содержит готовый `moscow.pmtiles`.
- `src/styles/tokens.css` — токены дизайн-системы rundom (две нити: петроль и кармин).
- `docs/SPEC.md` — техническое задание и этапы.
- `legacy/` — исходный прототип.

Деплой: GitHub Actions публикует `dist/` на GitHub Pages при каждом push в `main`.
Данные покрытия и тайлы карты обновляет ежемесячный workflow `data.yml`: он выпускает релиз `data-YYYY-MM` и запускает деплой.
