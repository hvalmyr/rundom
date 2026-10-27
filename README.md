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
- `src/map/` — карта Leaflet и подложки.
- `src/ui/` — вкладки «Маршрут», «Библиотека», «Прогресс», настройки, нижний лист на телефоне.
- `src/storage/` — хранение на устройстве.
- `src/data/` — запросы к Overpass и границы районов (`districts.json`).
- `scripts/build-districts.mjs` — пересборка границ районов из OSM: `npm run data:districts`.
- `src/styles/tokens.css` — токены дизайн-системы rundom (две нити: петроль и кармин).
- `docs/SPEC.md` — техническое задание и этапы.
- `legacy/` — исходный прототип.

Деплой: GitHub Actions публикует `dist/` на GitHub Pages при каждом push в `main`.
