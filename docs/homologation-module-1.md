# Homologação — Módulo 1: contas, atribuições e permissões

Este procedimento é exclusivamente para um projecto Supabase de homologação. Não execute estes ficheiros no projecto de produção até a validação ser aprovada.

## Pré-requisitos

- Projecto Supabase de homologação separado, com Auth por e-mail activo.
- Variáveis desse projecto num deployment/preview separado do Vercel.
- Conjunto de contas de teste: Professor Administrador, Professor A, Professor B, Secretária e pelo menos dois alunos.
- Uma cópia não produtiva do esquema antigo, com `profiles` e `course_state`.

## Ordem de execução

1. Publique a versão-ponte num preview ligado à homologação **antes de aplicar a migração**. Com o papel legado `teacher_admin`, confirme o login do administrador e a criação de uma conta de teste.
2. Execute [00_profile_snapshot.sql](../supabase/validation/00_profile_snapshot.sql).
3. Execute [001_accounts_assignments.sql](../supabase/migrations/001_accounts_assignments.sql).
4. Execute [02_assert_module1.sql](../supabase/validation/02_assert_module1.sql). Confirme que o UUID do administrador é o mesmo capturado no passo 2.
5. No painel `/admin/provisioning`, crie `Matemática` e `Física`, uma conta fictícia de `Secretária` e associe Aluno 1 ao Professor A/Matemática e Aluno 2 ao Professor B/Física. A associação é uma linha por combinação Professor–Aluno–Disciplina.
6. Execute [04_assert_transition_data.sql](../supabase/validation/04_assert_transition_data.sql) e guarde a saída como referência da fase migrada.
7. Teste a versão-ponte com o mesmo administrador, agora `admin_teacher`: login, criação de conta e gestão das atribuições.
8. Publique apenas num preview com as variáveis de homologação e execute os cenários abaixo.

## O que é preenchido automaticamente

| Registo antigo | Resultado após a migração |
|---|---|
| `profiles.id` | Mantido exactamente igual. |
| `username`, nome e credenciais Auth | Mantidos. Apenas `teacher_admin` passa a `admin_teacher`. |
| Perfil `student` | Recebe linha activa em `student_enrollments`. |
| `course_state` | Copiado uma vez para `private.legacy_course_state_archive`; não é exposto pela API pública. |

## Associações que exigem decisão manual

- Cada aluno existente: professor(es) responsável(eis) e disciplina(s).
- Professores que acompanham o mesmo aluno em disciplinas diferentes: uma atribuição por disciplina.
- Alunos inactivos ou que já saíram: decidir se a matrícula deve ser encerrada antes da associação.
- Materiais legados sem disciplina/aluno: ficam disponíveis apenas ao Professor Administrador até à migração do módulo de materiais.

As duas consultas finais de `02_assert_module1.sql` listam exactamente os alunos e professores sem associação.

## Cenários integrados obrigatórios

| Perfil | Acção esperada |
|---|---|
| Professor Administrador | Inicia sessão com o mesmo UUID Auth, cria disciplina/atribuição, consulta o centro. |
| Professor A | `GET /api/assignments` devolve apenas Aluno 1; `GET /api/state` não devolve Aluno 2. |
| Professor B | O inverso de Professor A. Tentar `GET /api/assets/read?assetId=<ficheiro-do-outro-aluno>` devolve 404/403. |
| Secretária | Não recebe atribuições nem consegue escrever `/api/state`; nesta fase não recebe ficheiros pedagógicos. |
| Aluno | Vê apenas as próprias tarefas/submissões; URL de ficheiro de outro aluno devolve 404/403. |

Verificação adicional: com uma chave anon e sessão de aplicação, tente ler `private.legacy_course_state_archive` por PostgREST. O pedido deve falhar porque o esquema/tabela não estão expostos nem concedidos a `authenticated`.

## Teste controlado da versão anterior e reversão

O código anterior do Centro reconhece apenas `teacher_admin`. Portanto, **não é seguro** fazer rollback apenas do Vercel depois de converter os papéis.

1. Registe o commit exacto da versão anterior e a URL do preview que lhe corresponde.
2. Com a base migrada, aponte esse preview anterior para a homologação. Teste e registe separadamente: a) login do administrador; b) abertura do painel administrativo; c) criação de conta. Não pressupor o resultado: o login Auth pode passar e o painel recusar o perfil.
3. Execute [03_revert_roles_for_legacy_release.sql](../supabase/validation/03_revert_roles_for_legacy_release.sql), ainda em homologação. Aplique novamente o passo 2: o mesmo UUID deve iniciar sessão e gerir contas com o código anterior.
4. Execute [04_assert_transition_data.sql](../supabase/validation/04_assert_transition_data.sql). A Secretária e todas as atribuições criadas no passo migrado devem permanecer na base. A versão antiga não deve disponibilizar a conta da Secretária.
5. Reaplique [001_accounts_assignments.sql](../supabase/migrations/001_accounts_assignments.sql). As tabelas, índices e triggers usam `if not exists`/`drop ... if exists`; a reaplicação converte de novo o administrador, preserva Secretária e atribuições e não duplica matrículas.
6. Execute novamente `04_assert_transition_data.sql` e compare com a saída guardada no passo 6 anterior. Volte à versão-ponte e confirme login, matrícula e atribuições.
7. Em produção: backup lógico, versão-ponte, migração, testes de fumos e monitorização. Nunca publicar código anterior sobre uma base migrada sem a reversão de papel validada.

Se algum perfil perder acesso, mantenha a versão-ponte activa. Caso seja indispensável regressar ao código anterior, aplique primeiro a reversão de papel acima, confirme o login do administrador e só então faça rollback do Vercel. Não elimine o arquivo privado nem as tabelas novas. Para voltar à versão-ponte, reaplique `001_accounts_assignments.sql` numa transacção validada.
