# Checklist de release — Sala de Aula Virtus

## Bloqueadores antes de abrir provas

- [ ] Executar a versão atual de `supabase/schema.sql`.
- [ ] Configurar `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` no ambiente **Production** da Vercel.
- [ ] Definir exatamente uma conta confiável com `is_superadmin = true`.
- [x] Versionar o runtime, os binários WASM SIMD/fallback e `assets/vendor/mediapipe/models/face_landmarker.task`, seguindo [vendor-licenses.md](vendor-licenses.md).
- [ ] Abrir uma prova num dispositivo real, conceder câmara/microfone e concluir a calibração.
- [ ] Executar `npm install`, `npx playwright install`, `npm run test:unit` e `npm run test:e2e` contra o projeto Supabase de testes.
- [ ] Confirmar que um aluno sem atribuição não recebe o enunciado nem o URL de ficheiros de outro grupo.
- [ ] Executar **Verificar armazenamento** em Aulas e resolver qualquer item legado antes de remover o respetivo ficheiro local.

## Publicação

- [ ] Confirmar que o autor do commit tem um e-mail verificado na conta GitHub ligada à equipa Vercel; autores não reconhecidos bloqueiam o deployment.

## Pós-publicação

- [ ] Confirmar que `/api/auth/config` responde com a configuração pública sem expor a chave de serviço.
- [ ] Criar uma conta descartável pelo painel `/admin/provisioning`.
- [ ] Efetuar primeiro acesso, trocar a palavra-passe temporária e confirmar que o perfil foi criado.
- [ ] Carregar e descarregar um documento abaixo de 50 MB; confirmar que um ficheiro de 50 MB ou mais mostra um toast explicativo.

