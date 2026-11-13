# Centro de Estudos e Explicações Virtus

Base independente da **Plataforma de Ensino V - Online**. Este repositório não partilha código publicado, variáveis de ambiente, base de dados nem armazenamento com a Sala de Aula Virtus.

## Publicação em produção — configuração bloqueada

- **Domínio oficial exclusivo:** [`https://centro-estudosvirtus.vercel.app`](https://centro-estudosvirtus.vercel.app)
- **Projeto Vercel correto:** `virtus-projects1/centro-estudosvirtus` (**sem hífen** entre `estudos` e `virtus`).
- O vínculo local está fixado em `.vercel/project.json` com `projectId` `prj_dylOjh0NFC0PniBqE2aPQILD3JYU` e `orgId` `team_kRKERV1eyDzqYnzXVkYkawsg`.
- Antes de qualquer publicação, execute `npx vercel whoami` e confirme que a CLI está ligada à conta autorizada. Em seguida utilize exclusivamente `npx vercel --prod --yes` a partir da raiz deste repositório e valide o alias devolvido pelo Vercel.
- **Nunca** publique este código no projeto semelhante `centro-estudos-virtus` (com hífen): esse não é o portal oficial do Centro.

## Estado actual

O Passo 1 está preparado:

- esquema Supabase isolado e evolução segura para contas, disciplinas e atribuições;
- rota segura para criar matrículas em `api/admin/provision.js`;
- geração automática de `nome.apelido`, e-mail virtual e palavra-passe inicial `123456`;
- perfis `Aluno`, `Professor`, `Professor Administrador` e `Secretária`;
- atribuições explícitas Professor–Aluno–Disciplina: um professor consulta apenas os alunos que lhe foram atribuídos;
- troca obrigatória de palavra-passe no primeiro acesso;
- painel de matrícula em `/admin/provisioning`.

## Base de dados: instalação ou actualização

Numa base **nova**, execute primeiro [schema.sql](supabase/schema.sql) no SQL Editor e, em seguida, [001_accounts_assignments.sql](supabase/migrations/001_accounts_assignments.sql).

Numa base que já tem o Centro Virtus antigo, execute **apenas** [001_accounts_assignments.sql](supabase/migrations/001_accounts_assignments.sql). A migração:

- remove a antiga restrição de papéis antes de converter `teacher_admin` para `admin_teacher`;
- arquiva a cópia histórica de `course_state` no esquema privado `private`, sem acesso por API pública;
- cria `subjects`, `student_enrollments` e `teacher_student_subject_assignments` com RLS e validação de papéis;
- não apaga anexos, entregas ou o estado histórico. Cada módulo será migrado depois de reconciliar os IDs existentes.

## Variáveis necessárias no novo Vercel

Configure apenas no futuro projecto Vercel `centro-estudosvirtus`:

```text
SUPABASE_URL=https://uqpwtltdamdqxquwqioh.supabase.co
SUPABASE_ANON_KEY=<anon key do novo projecto>
SUPABASE_SERVICE_ROLE_KEY=<service role/secret key do novo projecto>
CENTRO_BOOTSTRAP_TOKEN=<segredo longo e exclusivo>
```

A primeira conta deve ser criada em `/admin/provisioning?setup=1` com a chave `CENTRO_BOOTSTRAP_TOKEN`. Em seguida, os Professores Admin criam as restantes contas pelo painel normal.

## Limites do passo actual

O Virtus Detector, a Preparação para Provas e Exames, o Radar consolidado e o Pátio serão adaptados em etapas posteriores. A Sala de Aula Virtus continua no seu próprio repositório, Vercel e Supabase.
