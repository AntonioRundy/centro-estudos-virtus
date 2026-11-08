# Componentes vendorizados

A aplicação serve estes recursos a partir de `/assets`, sem carregar fontes ou ícones de CDNs durante a utilização normal.

| Componente | Localização | Licença/origem |
| --- | --- | --- |
| Inter Variable | `assets/fonts/InterVariable.woff2` | SIL Open Font License 1.1 — rsms/inter |
| Ícones compatíveis com Lucide | `assets/vendor/lucide.min.js` | Lucide Icons, ISC |
| MediaPipe Tasks Vision | `assets/vendor/mediapipe/` | Google MediaPipe, Apache-2.0 |

## Atualização controlada

Atualize o conjunto MediaPipe como uma unidade: `vision_bundle.mjs`, os dois carregadores JavaScript WASM, os binários `.wasm` SIMD/fallback e o modelo `face_landmarker.task`. Depois valide a calibração de câmara em ambiente de homologação antes de publicar.

O modelo deve ser obtido exclusivamente da distribuição oficial MediaPipe e guardado em `assets/vendor/mediapipe/models/face_landmarker.task`. Registe a versão e o SHA-256 num PR. Não substitua o modelo por um ficheiro de origem desconhecida.
