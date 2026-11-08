# Sala de Aula Virtus

Plataforma académica privada da Universidade Agostinho Neto — Faculdade de Ciências Naturais, para a unidade curricular de Diagrafias. Permite gerir turma, conteúdos, avaliações, entregas individuais e em grupo, pautas e monitoria de provas online.

## Stack atual

- **Frontend:** aplicação Vanilla JavaScript, HTML e CSS, servida pela Vercel.
- **Backend:** Vercel Serverless Functions em `/api`.
- **Identidade:** Supabase Auth; cada utilizador inicia sessão com uma conta individual.
- **Dados partilhados:** Supabase Postgres, com estado da turma protegido por RLS e endpoints de servidor.
- **Ficheiros:** Supabase Storage privado. A aplicação cria URLs assinados de duração limitada para abrir ficheiros autorizados.
- **Virtus Detector:** MediaPipe Face Landmarker no navegador, combinado com telemetria de foco, ecrã inteiro, ruído e eventos de integridade. A monitoria produz métricas de revisão; não toma decisões disciplinares automáticas.

## Produção

### Variáveis na Vercel

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

A chave de serviço só é usada pelas funções da Vercel. Nunca deve ser exposta no navegador, num ficheiro público ou num repositório.

### Base de dados

1. Execute [supabase/schema.sql](supabase/schema.sql) no SQL Editor do projeto Supabase.
2. Crie o bucket privado `sala-virtus-private` e aplique as políticas descritas em [README-auth.md](README-auth.md).
3. Para ativar o provisionamento, marque **apenas uma conta de confiança** como superadministradora:

```sql
update public.profiles
set is_superadmin = true
where username = 'nome.do.administrador';
```

## Provisionamento de contas

O painel protegido está em `/admin/provisioning`. Só uma sessão cujo perfil tenha `is_superadmin = true` pode criar contas.

- Criação unitária: nome completo, utilizador e perfil (aluno/docente).
- Importação CSV: cabeçalho `username,full_name,role`.
- A aplicação gera uma palavra-passe temporária por conta, devolve-a uma única vez no ecrã e exige alteração no primeiro acesso.
- O endpoint cria o utilizador no Supabase Auth e, só depois, o perfil correspondente em `public.profiles`. Se o perfil falhar, a conta Auth é removida para evitar registos órfãos.

## Ficheiros e armazenamento

- Limite por ficheiro: **50 MB**.
- As áreas de Aulas e Trabalhos validam o limite antes do envio e apresentam um toast explicativo quando algo falha.
- Docentes podem executar a **Verificação de armazenamento** em Aulas para localizar itens legados sem referência ao bucket privado.
- Ligações a ficheiros são sempre assinadas no servidor; não se guardam URLs públicos persistentes no estado da turma.

## Avaliação

Todas as notas usam a escala 0–20. A média da pauta é calculada automaticamente com os pesos:

| Componente | Peso |
| --- | ---: |
| 1.ª avaliação / questionários | 17,5% |
| 2.ª avaliação escrita | 17,5% |
| 3.ª avaliação escrita | 17,5% |
| Avaliação prática | 30% |
| Outros / participação | 17,5% |

Se uma componente ainda não tiver nota, a média usa apenas as componentes lançadas e normaliza os pesos restantes.

## Qualidade e testes

O projeto inclui configuração para Playwright em `playwright.config.mjs` e testes de caminho crítico em `tests/e2e/critical-flow.spec.mjs`.

```bash
npm install
npx playwright install --with-deps
npm run test:e2e
```

Execute os testes contra um projeto Supabase de testes, com contas descartáveis. Não use contas ou dados reais de alunos durante QA.

## Recursos locais

A fonte Inter, os ícones e o pacote oficial do MediaPipe (runtime, WASM SIMD/fallback e `face_landmarker.task`) são versionados em `assets/`. O loader do Virtus Detector resolve estes recursos apenas por caminhos locais e bloqueia a prova com uma mensagem explícita se algum ficheiro for removido, em vez de recorrer silenciosamente a um CDN.

## Arquivo histórico

Documentos da arquitetura anterior baseada em Google Apps Script estão em [docs/archive](docs/archive). Não fazem parte da arquitetura em produção.
